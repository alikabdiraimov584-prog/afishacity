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
  assert.ok(m.seen[1].some(x=>/поиск сейчас не сработал/.test(x.text)&&!/Overpass 504/.test(x.text)),
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
  // Раунды плюс один заключительный ход без инструментов: иначе, если модель
  // на последнем раунде снова просит поиск, ответа по нему не прозвучит.
  assert.ok(m.seen.length<=4,"обращений к модели не больше раундов + один заключительный");
  assert.match(m.seen.at(-1).at(-1).text,/больше инструментов не будет/);
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
  // Два хода с инструментами и один заключительный без них — чтобы человек
  // услышал ответ, а не только «секунду, смотрю».
  assert.equal(m.seen.length,3,"вслух — два хода с поиском плюс заключительный ответ");
  assert.match(m.seen.at(-1).at(-1).text,/больше инструментов не будет/);
});

const FEMALE_VOICES=new Set(["alena","jane","omazh","dasha","julia","lera","marina","masha"]);
const MALE_VOICES=new Set(["filipp","ermil","zahar","madirus","anton","alexander","kirill"]);
const FEMALE_NAMES=new Set(["Варя","Маша","Рита","Ася","Женя","Ника","Мира"]);
const MALE_NAMES=new Set(["Савва","Гриша","Тимур","Лёва","Марк","Женя"]);

test("пол голоса и имя агента не расходятся", async () => {
  const {CONCIERGE}=await import("../agent.mjs");
  // Этот тест уже ловил одну такую ошибку: у Саввы стояла alena, то есть
  // голос Алисы. Проверять «голос не из списка женских» оказалось мало —
  // masha в список не попала, и расхождение проехало молча. Поэтому здесь
  // сверяются обе стороны, и добавить новый голос, не тронув имя, нельзя.
  const female=FEMALE_VOICES.has(CONCIERGE.voice),male=MALE_VOICES.has(CONCIERGE.voice);
  assert.ok(female||male,`голос ${CONCIERGE.voice} не описан: добавьте его в список и проверьте имя`);
  if(female)assert.ok(FEMALE_NAMES.has(CONCIERGE.name),
    `голос ${CONCIERGE.voice} женский, а имя «${CONCIERGE.name}» мужское`);
  else assert.ok(MALE_NAMES.has(CONCIERGE.name),
    `голос ${CONCIERGE.voice} мужской, а имя «${CONCIERGE.name}» женское`);
});

test("описание личности согласовано по роду", async () => {
  const {CONCIERGE,agentSystem}=await import("../agent.mjs");
  const female=FEMALE_VOICES.has(CONCIERGE.voice);
  const text=[...CONCIERGE.traits,agentSystem({})].join(" ");
  // Смена голоса легко оставляет прежние формы: «честный», «предложил и
  // отошёл», «Какой ты». В речи от первого лица это слышно сразу.
  const male=/\b(честный|спокойный|уверенный|внимательный)\b|предложил и отошёл|Какой ты:/;
  const fem=/\b(честная|спокойная|уверенная|внимательная)\b|предложила и отошла|Какая ты:/;
  if(female){
    assert.ok(!male.test(text),"у женского голоса остались мужские формы");
    assert.ok(fem.test(text));
  }else{
    assert.ok(!fem.test(text),"у мужского голоса остались женские формы");
    assert.ok(male.test(text));
  }
});

test("личность и умолчание клиента не разъезжаются", async () => {
  const {CONCIERGE}=await import("../agent.mjs");
  const {yandexConfig}=await import("../yandex.mjs");
  assert.equal(CONCIERGE.voice,yandexConfig({}).voice);
  assert.equal(CONCIERGE.voiceRole,yandexConfig({}).role);
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

test("промежуточная реплика помечена как непроизносимая", async () => {
  // Живой разговор: «ответ дублируется, будто два агента отвечают по очереди».
  // Агент говорит дважды за ход: сперва «секунду, смотрю», потом ответ. Лёгкая
  // модель кладёт в первую реплику готовый ответ — и он звучит дважды.
  const m=model(
    JSON.stringify({say:"Секунду, смотрю",tool:"recommend_free",args:{query:"бар"}}),
    JSON.stringify({say:"Ровесник в двух шагах.",tool:null}));
  const seen=[];
  await runYandexDialogue("бар рядом",[],{cfg:CFG,fetchImpl:m.fetchImpl,voice:true,
    emit:(t,d)=>{if(t==="delta")seen.push(d)},
    deps:{recommend_free:async()=>PLACES}});
  assert.deepEqual(seen.map(d=>d.interim),[true,false],"озвучивать можно только последнюю");
  assert.equal(seen[1].text,"Ровесник в двух шагах.");
});

test("реплика без поиска произносится сразу", async () => {
  const m=model(JSON.stringify({say:"Уточни, в каком районе?",tool:null}));
  const seen=[];
  await runYandexDialogue("что-нибудь",[],{cfg:CFG,fetchImpl:m.fetchImpl,voice:true,
    emit:(t,d)=>{if(t==="delta")seen.push(d)},deps:{}});
  assert.deepEqual(seen.map(d=>d.interim),[false],"тут нечего ждать — это и есть ответ");
});

test("модели уходят только известные факты, без пустот и служебного примечания", async () => {
  const {toolResultForAgent}=await import("../agent.mjs");
  // Жалоба: «постоянно говорит, что у него нет данных». Модели уходили
  // цена:null, часы:null, открыто:"неизвестно" и примечание про источники —
  // и она, которой запрещено выдумывать, честно пересказывала пустоты.
  const bare={name:"Бар на Пятницкой",category:"Бар",area:null,metro:null,price:null,time:null,
    open_now:null,closes_at:null,distance_km:2.3,reasons:["бар"]};
  const seen=JSON.parse(toolResultForAgent("recommend_free",{results:[bare],note:"Часть источников временно недоступна."}));
  const place=seen.места[0];
  for(const k of ["цена","часы","открыто_сейчас","закрывается","район"])assert.ok(!(k in place),`${k} не должно быть в объекте`);
  assert.ok(!("примечание" in seen),"служебное примечание модели ни к чему");
  assert.ok(!JSON.stringify(seen).includes("null"),"ни одного null");
  assert.ok(!JSON.stringify(seen).includes("неизвестно"));
  // А известное — на месте.
  const full={...bare,price:"1500 ₽",time:"до 04:00",open_now:true,area:"Китай-город"};
  const p2=JSON.parse(toolResultForAgent("recommend_free",{results:[full]})).места[0];
  assert.equal(p2.цена,"1500 ₽");assert.equal(p2.открыто_сейчас,true);assert.equal(p2.район,"Китай-город");
});

test("агенту запрещены фразы про отсутствие данных", async () => {
  const {agentSystem}=await import("../agent.mjs");
  const t=agentSystem({voice:true});
  assert.match(t,/«у меня нет данных»/);
  assert.match(t,/Имени и категории достаточно/);
});

test("рейтинг попадает модели только с числом отзывов", async () => {
  const {toolResultForAgent}=await import("../agent.mjs");
  const base={name:"Бар",category:"Бар"};
  const say=(r)=>JSON.parse(toolResultForAgent("recommend_free",{results:[{...base,...r}]})).места[0];
  // «Пять звёзд» от трёх человек — не довод, и произносить его как довод нельзя.
  assert.equal(say({rating:5,rating_count:3}).оценка,undefined);
  assert.equal(say({rating:null,rating_count:900}).оценка,undefined);
  const good=say({rating:4.6,rating_count:1847});
  assert.equal(good.оценка,4.6);assert.equal(good.отзывов,1847);
});

test("вслух звучит ответ, даже если модель до конца просит инструмент", async () => {
  // «Она не разговаривает и не показывает результат»: на экране висел текст
  // ответа, но вслух не прозвучало ничего, а подсказка так и осталась «Ищу».
  // Лёгкая модель к каждой реплике прицепляла ещё один поиск — и каждая
  // уезжала к клиенту как промежуточная, то есть непроизносимая. Запасная
  // фраза не спасала: она смотрела на число реплик, а реплики-то были.
  const m=model(...Array(5).fill(JSON.stringify({say:"Ближе всего Ровесник",
    tool:"recommend_free",args:{query:"бар"}})));
  const seen=[];
  await runYandexDialogue("бар рядом",[],{cfg:CFG,fetchImpl:m.fetchImpl,voice:true,
    emit:(t,d)=>{if(t==="delta")seen.push(d)},
    deps:{recommend_free:async()=>PLACES}});
  assert.ok(seen.some(d=>!d.interim),"хоть одна реплика должна быть произносимой");
});

test("пустой повторный поиск не стирает уже найденное", async () => {
  // Второй заход модель делает с другим запросом. Если он вернул пусто, это
  // не значит, что показывать нечего: карточки из первого захода уже верные.
  const m=model(
    JSON.stringify({say:"Секунду",tool:"recommend_free",args:{query:"бар"}}),
    JSON.stringify({say:"Уточню",tool:"recommend_free",args:{query:"бар с едой"}}),
    JSON.stringify({say:"Ближе всего Ровесник",tool:null}));
  const out=await runYandexDialogue("бар рядом",[],{cfg:CFG,fetchImpl:m.fetchImpl,voice:true,
    deps:{recommend_free:async(a)=>a.query==="бар"?PLACES:{results:[]}}});
  assert.equal(out.results.length,1,"найденное в первом заходе остаётся");
  assert.equal(out.results[0].name,"Ровесник");
});

test("обещанием посмотреть разговор не заканчивается", async () => {
  const {isFiller}=await import("../dialogue_yandex.mjs");
  for(const t of ["Секунду, смотрю","Сейчас гляну","Щас","Минутку!","Ищу","ок, посмотрю"])
    assert.ok(isFiller(t),`«${t}» — обещание, а не ответ`);
  for(const t of ["Ближе всего Ровесник","Сейчас открыт только Ровесник на Китай-городе, идти семь минут","Нашла три бара"])
    assert.ok(!isFiller(t),`«${t}» — это ответ`);
});

test("если в конце только обещание, вслух уходит честный итог", async () => {
  const m=model(
    JSON.stringify({say:"Секунду",tool:"recommend_free",args:{query:"бар"}}),
    JSON.stringify({say:"Секунду",tool:"recommend_free",args:{query:"бар"}}),
    JSON.stringify({say:"Сейчас посмотрю",tool:"recommend_free",args:{query:"бар"}}));
  const seen=[];
  const out=await runYandexDialogue("бар",[],{cfg:CFG,fetchImpl:m.fetchImpl,voice:true,
    emit:(t,d)=>{if(t==="delta")seen.push(d)},deps:{recommend_free:async()=>PLACES}});
  const spoken=seen.filter(d=>!d.interim);
  assert.equal(spoken.length,1);
  assert.equal(spoken[0].text,"Вот что нашлось — смотри карточки.");
  assert.equal(out.text,"Вот что нашлось — смотри карточки.");
});
