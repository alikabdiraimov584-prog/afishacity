// Разговорный цикл на YandexGPT: модель просит инструмент текстом, мы выполняем
// его сами и возвращаем факты. Сеть подменена, поэтому проверяется сама логика.
import test from "node:test";
import assert from "node:assert/strict";
import {runYandexDialogue,trimHistory,MAX_HISTORY} from "../dialogue_yandex.mjs";

const CFG={key:"k",folder:"f",ready:true,model:"yandexgpt/latest",voice:"alena",
  emotion:"good",temperature:0.3,maxTokens:1500};
// Модель отвечает заранее заданной очередью реплик.
const model=(...turns)=>{
  const q=[...turns];const seen=[];
  return {seen,fetchImpl:async(_u,init)=>{
    seen.push(JSON.parse(init.body).messages);
    const text=q.shift()??JSON.stringify({say:"Больше нечего добавить",tool:null});
    return {ok:true,status:200,json:async()=>({result:{alternatives:[{message:{role:"assistant",text},
      status:"ALTERNATIVE_STATUS_FINAL"}],usage:{},modelVersion:"23"}})};
  }};
};
const PLACES={results:[{name:"Ровесник",category:"Бар",area:"Китай-город",open_now:true,closes_at:"04:00",reasons:["бар","в центре"]}]};

test("агент ищет и рассказывает о найденном", async () => {
  const m=model(
    JSON.stringify({say:"Смотрю, что открыто рядом",tool:"recommend_free",args:{query:"коктейльный бар"}}),
    JSON.stringify({say:"Есть «Ровесник» на Китай-городе, работает до четырёх",tool:null})
  );
  const calls=[];
  const r=await runYandexDialogue("хочу выпить",[],{cfg:CFG,fetchImpl:m.fetchImpl,
    deps:{recommend_free:async(a)=>{calls.push(a);return PLACES}}});
  assert.deepEqual(calls,[{query:"коктейльный бар"}]);
  assert.equal(r.tool_used,true);
  assert.match(r.text,/Смотрю, что открыто рядом/);
  assert.match(r.text,/Ровесник/);
  assert.equal(r.results.length,1);
  // Факты попали в диалог как отдельная реплика, а не были выдуманы моделью.
  const second=m.seen[1];
  assert.ok(second.some(x=>x.role==="user"&&/РЕЗУЛЬТАТ ПОИСКА/.test(x.text)));
  assert.ok(second.some(x=>/Ровесник/.test(x.text)));
});

test("без инструмента разговор заканчивается одним ходом", async () => {
  const m=model(JSON.stringify({say:"Поесть или выпить?",tool:null}));
  const r=await runYandexDialogue("привет",[],{cfg:CFG,fetchImpl:m.fetchImpl,deps:{}});
  assert.equal(r.text,"Поесть или выпить?");
  assert.equal(r.tool_used,false);
  assert.equal(m.seen.length,1,"лишних обращений к модели быть не должно");
});

test("отказ поиска агент озвучивает, а не замалчивает", async () => {
  const m=model(
    JSON.stringify({say:"Ищу",tool:"recommend_free",args:{query:"бар"}}),
    JSON.stringify({say:"Источник сейчас недоступен, попробуем через минуту",tool:null})
  );
  const r=await runYandexDialogue("бар",[],{cfg:CFG,fetchImpl:m.fetchImpl,
    deps:{recommend_free:async()=>{throw new Error("Overpass 504")}}});
  assert.match(r.text,/недоступен/);
  assert.ok(m.seen[1].some(x=>/поиск не удался: Overpass 504/.test(x.text)),
    "модель должна узнать причину отказа");
});

test("несуществующий инструмент не роняет разговор", async () => {
  const m=model(
    JSON.stringify({say:"Сейчас",tool:"сделай_хорошо",args:{}}),
    JSON.stringify({say:"Могу поискать места",tool:null})
  );
  const r=await runYandexDialogue("что-нибудь",[],{cfg:CFG,fetchImpl:m.fetchImpl,deps:{}});
  assert.match(r.text,/Могу поискать места/);
  assert.ok(m.seen[1].some(x=>/недоступен/.test(x.text)));
});

test("план вечера возвращается отдельным полем", async () => {
  const PLAN={stops:[{slot_start:"19:00",slot_end:"21:00",query:"ужин",place:{name:"Уголёк",area:"Тверская"}},
                     {slot_start:"21:20",slot_end:"23:00",query:"бар",place:{name:"Ровесник"}}],summary:"Вечер на двоих"};
  const m=model(
    JSON.stringify({say:"Собираю вечер",tool:"plan_evening",args:{stops:[{query:"ужин"},{query:"бар"}]}}),
    JSON.stringify({say:"Ужин в «Угольке», потом «Ровесник»",tool:null})
  );
  const r=await runYandexDialogue("поужинать и потом в бар",[],{cfg:CFG,fetchImpl:m.fetchImpl,
    deps:{plan_evening:async()=>PLAN}});
  assert.equal(r.plan,PLAN);
  assert.deepEqual(r.results.map(x=>x.name),["Уголёк","Ровесник"]);
});

test("цикл не может зациклиться на инструменте", async () => {
  const ask=JSON.stringify({say:"Ищу",tool:"recommend_free",args:{query:"бар"}});
  const m=model(ask,ask,ask,ask,ask);
  let runs=0;
  const r=await runYandexDialogue("бар",[],{cfg:CFG,fetchImpl:m.fetchImpl,
    deps:{recommend_free:async()=>{runs++;return PLACES}}});
  assert.ok(runs<=3,`инструмент вызван ${runs} раз`);
  assert.ok(m.seen.length<=3,"обращений к модели не больше числа раундов");
});

test("голосовой режим меняет правила речи в подсказке", async () => {
  const m=model(JSON.stringify({say:"Есть три варианта",tool:null}));
  await runYandexDialogue("бар",[],{cfg:CFG,fetchImpl:m.fetchImpl,deps:{},voice:true});
  const system=m.seen[0][0];
  assert.equal(system.role,"system");
  assert.match(system.text,/ГОВОРИШЬ ВСЛУХ/);
  assert.match(system.text,/ДВА ПРЕДЛОЖЕНИЯ/);
  // Главная причина «воды» вслух — пересказ того, что и так на карточке.
  assert.match(system.text,/НЕ произносишь часы работы, адреса, цены/);
  const m2=model(JSON.stringify({say:"x",tool:null}));
  await runYandexDialogue("бар",[],{cfg:CFG,fetchImpl:m2.fetchImpl,deps:{},voice:false});
  assert.ok(!/ГОВОРИШЬ ВСЛУХ/.test(m2.seen[0][0].text));
});

test("отмена прерывает разговор до обращения к модели", async () => {
  const ac=new AbortController();ac.abort();
  const m=model(JSON.stringify({say:"x",tool:null}));
  await assert.rejects(()=>runYandexDialogue("бар",[],{cfg:CFG,fetchImpl:m.fetchImpl,deps:{},signal:ac.signal}),
    (e)=>e.name==="AbortError");
  assert.equal(m.seen.length,0);
});

test("история обрезается по границе реплики человека", () => {
  const long=[];
  for(let i=0;i<40;i++){
    long.push({role:"user",text:`вопрос ${i}`});
    long.push({role:"assistant",text:`ответ ${i}`});
  }
  const cut=trimHistory(long);
  assert.ok(cut.length<=MAX_HISTORY);
  assert.equal(cut[0].role,"user","история начинается с реплики человека");
  // Пара «запрос — результат инструмента» не должна разрываться.
  const withTool=[{role:"user",text:"бар"},{role:"assistant",text:"{}"},
    {role:"user",text:"[РЕЗУЛЬТАТ ПОИСКА] {}"},{role:"assistant",text:"готово"}];
  assert.deepEqual(trimHistory(withTool,2)[0].role,"user");
  assert.ok(!trimHistory(withTool,2)[0].text.startsWith("[РЕЗУЛЬТАТ"),
    "обрезка не начинается с результата без запроса");
});

test("история продолжается между ходами", async () => {
  const m=model(JSON.stringify({say:"Слушаю",tool:null}));
  const first=await runYandexDialogue("привет",[],{cfg:CFG,fetchImpl:m.fetchImpl,deps:{}});
  const m2=model(JSON.stringify({say:"Понял",tool:null}));
  await runYandexDialogue("а теперь бар",first.messages,{cfg:CFG,fetchImpl:m2.fetchImpl,deps:{}});
  const sent=m2.seen[0].filter(x=>x.role!=="system");
  assert.equal(sent[0].text,"привет","прошлая реплика на месте");
  assert.equal(sent[sent.length-1].text,"а теперь бар");
});

// ---- Что произносится вслух ----

test("вслух итогом отдаётся только последняя реплика", async () => {
  // Промежуточное «секунду, смотрю» человек слышит сразу, пока идёт поиск.
  // Если оно попадёт ещё и в итог, он услышит его дважды — и оба раза с
  // задержкой на всю склейку.
  const m=model(
    JSON.stringify({say:"Секунду, смотрю",tool:"recommend_free",args:{query:"бар"}}),
    JSON.stringify({say:"Ближе всего Ровесник",tool:null}));
  const said=[];
  const out=await runYandexDialogue("бар рядом",[],{cfg:CFG,fetchImpl:m.fetchImpl,voice:true,
    emit:(t,d)=>{if(t==="delta")said.push(d.text)},
    deps:{recommend_free:async()=>PLACES}});
  assert.deepEqual(said,["Секунду, смотрю","Ближе всего Ровесник"],"обе реплики произносятся по мере готовности");
  assert.equal(out.text,"Ближе всего Ровесник","итог не повторяет уже сказанное");
});

test("в переписке видно весь ход целиком", async () => {
  const m=model(
    JSON.stringify({say:"Секунду, смотрю",tool:"recommend_free",args:{query:"бар"}}),
    JSON.stringify({say:"Ближе всего Ровесник",tool:null}));
  const out=await runYandexDialogue("бар",[],{cfg:CFG,fetchImpl:m.fetchImpl,voice:false,
    deps:{recommend_free:async()=>PLACES}});
  assert.equal(out.text,"Секунду, смотрю\nБлиже всего Ровесник");
});

test("вслух агент не ходит к модели третий раз", async () => {
  // Каждый лишний заход — ещё секунда тишины в живом разговоре.
  const m=model(...Array(5).fill(JSON.stringify({say:"ищу",tool:"recommend_free",args:{query:"бар"}})));
  await runYandexDialogue("бар",[],{cfg:CFG,fetchImpl:m.fetchImpl,voice:true,
    deps:{recommend_free:async()=>PLACES}});
  assert.equal(m.seen.length,2,"вслух — не больше двух обращений к модели");
});

test("у консьержа мужской голос, и он совпадает с умолчанием клиента", async () => {
  const {CONCIERGE}=await import("../agent.mjs");
  const {yandexConfig}=await import("../yandex.mjs");
  // Савва — мужское имя. Раньше здесь стояла alena, то есть голос Алисы:
  // собственный агент звучал как чужой продукт.
  assert.ok(!["alena","jane","omazh","dasha","julia","lera","marina"].includes(CONCIERGE.voice),
    "женский голос для Саввы — ошибка");
  assert.equal(CONCIERGE.voice,yandexConfig({}).voice,
    "личность и умолчание клиента не должны разъезжаться");
});

test("агент умеет попросить о близости отдельно от центра", async () => {
  const {AGENT_TOOLS,agentSystem}=await import("../agent.mjs");
  const rec=AGENT_TOOLS.find(t=>t.name==="recommend_free");
  assert.ok(rec.args.near,"у поиска есть признак близости");
  assert.match(rec.args.near,/ближайшее/);
  assert.match(rec.args.area,/только если человек прямо назвал центр/);
  assert.match(agentSystem({}),/Центр города тут ни при чём/);
});

// ---- Манера речи ----
// «Нужен слог молодёжный, но не прямо чтобы пиздюк»: две границы сразу,
// и обе легко потерять при следующей правке подсказки.

test("агент говорит на «ты» и не языком поддержки", async () => {
  const {agentSystem}=await import("../agent.mjs");
  const t=agentSystem({voice:true});
  assert.match(t,/На «ты»/);
  for(const canceler of ["рекомендую обратить внимание","данное заведение","локация"]){
    assert.ok(t.toLowerCase().includes(canceler),`канцелярит «${canceler}» должен быть назван запрещённым`);
  }
  assert.match(t,/Отличный выбор!/,"образец языка поддержки показан как антипример");
});

test("вторая граница: свой — не значит наглый", async () => {
  const {CONCIERGE,agentSystem}=await import("../agent.mjs");
  const never=CONCIERGE.never.join(" ").toLowerCase();
  assert.match(never,/не дерзит/);
  assert.match(never,/не матерится/);
  assert.match(never,/свой — не значит наглый/);
  // Перебор со сленгом показан примером: описания «не злоупотребляй» мало,
  // модели нужен образец того, чего делать нельзя.
  assert.match(agentSystem({voice:true}),/Бро, зацени/);
  assert.match(agentSystem({voice:true}),/это перебор/);
});

test("сленг дозирован, а не запрещён и не насыпан", async () => {
  const {agentSystem}=await import("../agent.mjs");
  const t=agentSystem({});
  assert.match(t,/одно на реплику/);
  assert.match(t,/понятно любому/,"речь должна оставаться понятной не только своим");
});
