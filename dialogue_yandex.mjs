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

export const MAX_ROUNDS=3;                    // ход модели + инструмент + вывод
export const VOICE_ROUNDS=2;                  // вслух: спросил инструмент — ответил
export const MAX_HISTORY=24;                  // чтобы подсказка не росла бесконечно

const TOOL_MARK="[РЕЗУЛЬТАТ ПОИСКА]";

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
  const system=agentSystem({voice,context:context.summary||""});
  const messages=trimHistory([...history,{role:"user",text:String(message||"")}]);

  const says=[];let results=[],plan=null,toolUsed=false;

  for(let round=0;round<maxRounds;round++){
    if(signal&&signal.aborted)throw Object.assign(new Error("клиент отключился"),{name:"AbortError"});

    const reply=await yandexComplete([{role:"system",text:system},...messages],
      {cfg,fetchImpl,signal,voice});
    const parsed=parseAgentReply(reply.text);
    // В историю кладём ровно то, что вернула модель: иначе на следующем ходу
    // она не увидит собственного формата и начнёт отвечать по-разному.
    messages.push({role:"assistant",text:reply.text});

    if(parsed.say){
      says.push(parsed.say);
      send("delta",{text:parsed.say});
    }
    if(!parsed.tool)break;

    const runner=deps[parsed.tool];
    if(typeof runner!=="function"){
      messages.push({role:"user",text:`${TOOL_MARK} инструмент «${parsed.tool}» недоступен. Ответь тем, что уже знаешь, и не вызывай его снова.`});
      continue;
    }

    send("status",deps.status?deps.status(parsed.tool,parsed.args):{stage:"searching",text:"Ищу"});
    if(parsed.say)send("break",{});
    toolUsed=true;
    try{
      const out=await runner(parsed.args||{},context);
      if(parsed.tool==="plan_evening"){plan=out;results=(out.stops||[]).map(s=>s.place).filter(Boolean)}
      else results=(out.results||[]).slice(0,5);
      messages.push({role:"user",text:`${TOOL_MARK} ${toolResultForAgent(parsed.tool,out)}\nСкажи об этом человеку своими словами. Ничего не добавляй от себя.`});
    }catch(e){
      // Отказ поиска — это факт, который агент обязан озвучить, а не замолчать.
      messages.push({role:"user",text:`${TOOL_MARK} поиск не удался: ${String(e&&e.message||e).slice(0,200)}. Скажи об этом честно и предложи, что делать дальше.`});
    }
  }

  // Вслух итог — только последняя реплика: предыдущие человек уже услышал,
  // пока шёл поиск. В переписке наоборот, там видно всё сразу.
  const text=(voice&&says.length>1?says[says.length-1]:says.join("\n")).trim();
  return {text,says:says.slice(),results,plan,tool_used:toolUsed,
    messages:trimHistory(messages),agent:CONCIERGE.name};
}
