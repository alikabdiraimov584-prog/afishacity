// Разговор с консьержем на движке YandexGPT.
//
// У YandexGPT в сообщениях есть только system, user и assistant — отдельной
// роли для результата инструмента нет. Поэтому цикл устроен так: модель просит
// инструмент в поле tool своего JSON-ответа, мы выполняем его сами и
// возвращаем факты обычным сообщением с пометкой. Для модели это выглядит как
// реплика «вот что нашлось», а не как выдумка.
//
// Инструменты сюда передаются снаружи (deps), а не импортируются: так весь цикл
// проверяется тестами без сети и без сервера.
import {agentSystem,parseAgentReply,toolResultForAgent,CONCIERGE} from "./agent.mjs";
import {yandexComplete,yandexConfig} from "./yandex.mjs";
import {LANG} from "./city.mjs";

export const MAX_ROUNDS=3;                    // ход модели + инструмент + вывод
export const VOICE_ROUNDS=2;                  // вслух: спросил инструмент — ответил
export const MAX_HISTORY=24;                  // чтобы подсказка не росла бесконечно

// Служебные реплики протокола — на языке модели: русские для Вари, английские для Noor.
const M=LANG==="en"?{
  mark:"[SEARCH RESULT]",
  unavailable:(t)=>`tool "${t}" is unavailable. Answer with what you already know and don't call it again.`,
  result:"Tell the person about this in your own words. Don't add anything of your own.",
  failed:"the search didn't work right now. Don't explain why and don't apologise. In one short sentence suggest trying again or rephrasing.",
  noMoreFailed:"there will be no more tools, and the search didn't work. In one sentence suggest trying again.",
  noMore:"there will be no more tools. Answer from what's already found, in one or two sentences.",
  searching:"Searching",
  foundFallback:"Here's what I found — check the cards.",
  nothingFallback:"Nothing yet. Try saying it differently?"
}:{
  mark:"[РЕЗУЛЬТАТ ПОИСКА]",
  unavailable:(t)=>`инструмент «${t}» недоступен. Ответь тем, что уже знаешь, и не вызывай его снова.`,
  result:"Скажи об этом человеку своими словами. Ничего не добавляй от себя.",
  failed:"поиск сейчас не сработал. Не объясняй причину и не извиняйся. Одним коротким предложением предложи повторить или переформулировать.",
  noMoreFailed:"больше инструментов не будет, и поиск не сработал. Одной фразой предложи повторить.",
  noMore:"больше инструментов не будет. Ответь по тому, что уже найдено, одной-двумя фразами.",
  searching:"Ищу",
  foundFallback:"Вот что нашлось — смотри карточки.",
  nothingFallback:"Пока не нашла. Скажи иначе?"
};
export const TOOL_MARK=M.mark;
export const VOICE_FALLBACK={found:M.foundFallback,nothing:M.nothingFallback};

/**
 * «Секунду, смотрю» — это не ответ, а обещание ответа.
 *
 * Такую реплику модель кладёт перед походом в поиск, и в середине хода она
 * уместна. Но если ею ход заканчивается, вслух прозвучит обещание, за которым
 * ничего не следует. Отличаем по началу фразы и по длине: развёрнутая реплика,
 * даже начатая с «сейчас», уже несёт что-то по существу.
 */
// \b в JavaScript считает границей только край латиницы, поэтому для русских
// слов он не срабатывает вовсе: «ищу» в конце строки границей не заканчивалось.
const FILLER_START=/^(?:ладно[,!. ]*|окей[,!. ]*|ок[,!. ]+|okay[,!. ]*|ok[,!. ]+|sure[,!. ]*|alright[,!. ]*)?(?:секунд|минут|момент|сейчас|щас|ща(?![а-яё])|подожд|погод|ищу(?![а-яё])|ищем(?![а-яё])|смотрю(?![а-яё])|гляну|глянем|посмотрю|поищу|поищем|проверю|one sec|one moment|just a sec|just a moment|hold on|hang on|let me (?:check|look|see)|checking|looking|searching|give me a (?:sec|moment))/i;
export function isFiller(say){
  const t=String(say||"").trim();
  if(!t)return true;
  if(t.length>60)return false;            // длинная фраза — это уже ответ
  return FILLER_START.test(t);
}

/** Обрезаем историю по границе реплики пользователя: иначе можно разорвать
 *  пару «запрос инструмента — его результат» и модель потеряет нить. */
export function trimHistory(messages,max=MAX_HISTORY){
  if(messages.length<=max)return messages;
  const isTurnStart=(m)=>m.role==="user"&&!String(m.text||"").startsWith(TOOL_MARK);
  for(let i=messages.length-max;i<messages.length;i++)if(isTurnStart(messages[i]))return messages.slice(i);
  // В хвосте границы нет — значит она осталась раньше. Отступаем назад, иначе
  // история начнётся с результата поиска без самого запроса, и модель увидит
  // факты, не понимая, о чём её спрашивали. Лишняя пара реплик дешевле.
  for(let i=messages.length-max-1;i>=0;i--)if(isTurnStart(messages[i]))return messages.slice(i);
  return messages;
}

/**
 * Один разговорный ход.
 * deps: {recommend(args), planEvening(args,context), status(name,args)} — status
 * отдаёт строку для индикатора «что сейчас делает агент».
 */
export async function runYandexDialogue(message,history=[],{
  context={},emit=null,signal=null,voice=false,
  cfg=yandexConfig(),fetchImpl=fetch,deps={},maxRounds=null
}={}){
  if(!Number.isFinite(maxRounds))maxRounds=voice?VOICE_ROUNDS:MAX_ROUNDS;
  const send=(type,data)=>{if(emit){try{emit(type,data)}catch{}}};
  // clock — «сейчас» с погодой от сервера; без него подсказка считает время сама.
  const system=agentSystem({voice,context:context.summary||"",clock:context.clock});
  const messages=trimHistory([...history,{role:"user",text:String(message||"")}]);

  const says=[];let results=[],plan=null,toolUsed=false;
  // Считаем не реплики, а произнесённое. Реплика с пометкой interim до
  // динамика не доходит: клиент её показывает, но молчит. Пока здесь стояло
  // says.length, ход, в котором модель к каждой фразе прицепляла ещё один
  // поиск, заканчивался полной тишиной — и экран навсегда оставался в «Ищу».
  let spoken=0;
  const say=(text,interim)=>{if(!interim)spoken++;send("delta",{text,interim})};

  let lastWasTool=false,toolFailed=false;
  for(let round=0;round<maxRounds;round++){
    if(signal&&signal.aborted)throw Object.assign(new Error("клиент отключился"),{name:"AbortError"});
    lastWasTool=false;

    const reply=await yandexComplete([{role:"system",text:system},...messages],
      {cfg,fetchImpl,signal,voice});
    const parsed=parseAgentReply(reply.text);
    // В историю кладём ровно то, что вернула модель: иначе на следующем ходу
    // она не увидит собственного формата и начнёт отвечать по-разному.
    messages.push({role:"assistant",text:reply.text});

    if(parsed.say){
      says.push(parsed.say);
      // Промежуточная реплика — та, после которой агент идёт искать. Вслух её
      // произносить нельзя: модель кладёт туда не «секунду, смотрю», а готовый
      // ответ, и человек слышит одно и то же дважды, будто отвечают по очереди.
      say(parsed.say,Boolean(parsed.tool));
    }
    if(!parsed.tool)break;

    const runner=deps[parsed.tool];
    if(typeof runner!=="function"){
      messages.push({role:"user",text:`${TOOL_MARK} ${M.unavailable(parsed.tool)}`});
      lastWasTool=true;                    // ответа по существу ещё не было
      continue;
    }

    send("status",deps.status?deps.status(parsed.tool,parsed.args):{stage:"searching",text:M.searching});
    if(parsed.say)send("break",{});
    toolUsed=true;lastWasTool=true;
    try{
      const out=await runner(parsed.args||{},context);
      toolFailed=false;
      // Пустой повторный заход не стирает найденное: второй запрос модель
      // делает уточняющим, и если он не дал ничего, правильные карточки из
      // первого захода — единственное, что есть показать.
      if(parsed.tool==="plan_evening"){
        const stops=(out.stops||[]).map(s=>s.place).filter(Boolean);
        if(stops.length||!results.length){plan=out;results=stops}
      }else{
        const found=(out.results||[]).slice(0,5);
        if(found.length||!results.length)results=found;
      }
      messages.push({role:"user",text:`${TOOL_MARK} ${toolResultForAgent(parsed.tool,out)}\n${M.result}`});
    }catch(e){
      // Отказ поиска — факт, который агент обязан озвучить, а не замолчать.
      // Но не текстом исключения: «fetch failed» и «504 Gateway Timeout»
      // уходили модели с указанием озвучить, и она их озвучивала. Причина —
      // в лог, человеку — короткое «сейчас не вышло, давай ещё раз».
      console.error("инструмент",parsed.tool,"не сработал:",e&&e.message||e);
      toolFailed=true;
      messages.push({role:"user",text:`${TOOL_MARK} ${M.failed}`});
    }
  }

  // Ходы кончились на запросе инструмента: результаты уже в истории, но
  // ответа по ним не прозвучало — человек услышал бы только «секунду, смотрю».
  // Один добавочный ход без инструментов, чтобы ответ по существу был.
  if(lastWasTool&&!(signal&&signal.aborted)){
    const what=toolFailed
      ?`${TOOL_MARK} ${M.noMoreFailed}`
      :`${TOOL_MARK} ${M.noMore}`;
    messages.push({role:"user",text:what});
    try{
      const reply=await yandexComplete([{role:"system",text:system},...messages],{cfg,fetchImpl,signal,voice});
      const parsed=parseAgentReply(reply.text);
      messages.push({role:"assistant",text:reply.text});
      // Инструмент в заключительном ходе — оплошность формата, а не признак
      // того, что говорить нечего: модели прямо сказали, что поиска больше не
      // будет, и она всё равно ответила по найденному. Такой ответ произносим.
      // Отбрасываем только обещание посмотреть: им разговор кончиться не может.
      if(parsed.say&&!isFiller(parsed.say)){says.push(parsed.say);say(parsed.say,false)}
    }catch(e){
      // Модель отвалилась на последнем ходу — найденное терять незачем.
      console.error("заключительный ход не удался:",e&&e.message||e);
    }
  }
  // Что бы ни случилось, вслух должно прозвучать хоть что-то: иначе экран
  // остаётся в «думаю» навсегда, а карточки уже показаны.
  if(voice&&!spoken){
    const fallback=results.length?M.foundFallback:M.nothingFallback;
    says.push(fallback);say(fallback,false);
  }
  // Вслух итог — только последняя реплика: предыдущие человек уже услышал,
  // пока шёл поиск. В переписке наоборот, там видно всё сразу.
  const text=(voice&&says.length>1?says[says.length-1]:says.join("\n")).trim();
  return {text,says:says.slice(),results,plan,tool_used:toolUsed,
    messages:trimHistory(messages),agent:CONCIERGE.name};
}
