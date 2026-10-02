// Что модель знает о «сейчас» и о разговоре: дата и время города, «ещё» без
// повторов, «ближайшее», уровень цен, честность про афишу, кнопки карточек.
// Московские проверки идут в этом процессе; дубайские — в отдельном с
// CITY=dubai: город читается из env при первом импорте city.mjs.
import "./_moscow.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
process.env.NODE_ENV="test";

const {normalizeWhen,wantsMore,shownIdsFrom,nowLine,agentSystem,toolResultForAgent,agentTools,addDays}=await import("../agent.mjs");
const {cityDate}=await import("../city.mjs");
const {cacheKey,cleanSearchArgs,dialogueRecommend,knownLocation}=await import("../server.mjs");

// 22:35 по Москве (UTC+3).
const EVENING=new Date("2026-10-02T19:35:00Z");

test("прошедшее время на сегодня сдвигается к «сейчас», до ближайших 15 минут", () => {
  const a=normalizeWhen({target_date:"2026-10-02",after_time:"19:00"},{now:EVENING});
  assert.deepEqual(a,{target_date:"2026-10-02",after_time:"22:45"});
  // Без даты — тоже сегодня.
  assert.equal(normalizeWhen({after_time:"20:30"},{now:EVENING}).after_time,"22:45");
  // «today» и «tonight» словами — сегодняшняя дата.
  assert.equal(normalizeWhen({target_date:"tonight"},{now:EVENING}).target_date,"2026-10-02");
  assert.equal(normalizeWhen({target_date:"tomorrow"},{now:EVENING}).target_date,"2026-10-03");
  // Будущее не трогаем.
  assert.deepEqual(normalizeWhen({target_date:"2026-10-03",after_time:"10:00"},{now:EVENING}),{target_date:"2026-10-03",after_time:"10:00"});
  assert.equal(normalizeWhen({after_time:"23:00"},{now:EVENING}).after_time,"23:00");
  // «После двух ночи», сказанное вечером, — завтрашняя дата.
  assert.deepEqual(normalizeWhen({after_time:"02:00"},{now:EVENING}),{target_date:"2026-10-03",after_time:"02:00"});
  // Прошедшая дата (модель ошиблась годом) и мусор — выбрасываются.
  assert.deepEqual(normalizeWhen({target_date:"2025-10-02",after_time:"7pm"},{now:EVENING}),{});
  // Ровно к полуночи — уже завтра, 00:00.
  const late=new Date("2026-10-02T20:52:00Z");                 // 23:52
  assert.deepEqual(normalizeWhen({after_time:"21:00"},{now:late}),{target_date:"2026-10-03",after_time:"00:00"});
  // Для плана то же самое делает start_time.
  assert.equal(normalizeWhen({start_time:"19:00"},{now:EVENING,timeKey:"start_time"}).start_time,"22:45");
});

test("«ещё» и «другое» — просьба о новых местах, «подробнее» — нет", () => {
  for(const t of ["show me more","something else","another option","any other bars?","different place please","ещё варианты","покажи другие","а что-нибудь другое?"])
    assert.ok(wantsMore(t),t);
  for(const t of ["tell me more about Zuma","more info on it","расскажи подробнее","бар рядом","nearest pharmacy","cheaper"])
    assert.ok(!wantsMore(t),t);
});

test("показанное достаётся из истории обоих движков", () => {
  const claude=[
    {role:"user",content:"bar"},
    {role:"assistant",content:[{type:"tool_use",id:"t1",name:"recommend_free",input:{query:"bar"}}]},
    {role:"user",content:[{type:"tool_result",tool_use_id:"t1",content:JSON.stringify({found:2,places:[{id:"osm:1",name:"A"},{id:"osm:2",name:"B"}]})}]}
  ];
  assert.deepEqual(shownIdsFrom(claude).sort(),["osm:1","osm:2"]);
  const yandex=[{role:"user",text:"бар"},{role:"assistant",text:"{}"},
    {role:"user",text:`[РЕЗУЛЬТАТ ПОИСКА] ${JSON.stringify({найдено:1,места:[{id:"kudago:9",name:"Бар"}]})}\nСкажи об этом`}];
  assert.deepEqual(shownIdsFrom(yandex),["kudago:9"]);
});

test("ключ кеша выдачи учитывает исключения и новые аргументы, но не порядок полей", () => {
  const a=cleanSearchArgs({query:"bar",exclude_ids:["b","a","a"],price_level_max:"2",near:"true"});
  assert.deepEqual(a,{query:"bar",exclude_ids:["a","b"],price_level_max:2,near:true});
  assert.equal(cacheKey({query:"bar",near:true}),cacheKey({near:true,query:"bar"}));
  assert.notEqual(cacheKey(cleanSearchArgs({query:"bar"})),cacheKey(cleanSearchArgs({query:"bar",exclude_ids:["x"]})));
  assert.notEqual(cacheKey(cleanSearchArgs({query:"bar"})),cacheKey(cleanSearchArgs({query:"bar",price_level_min:3})));
  // Мусор отсекается: уровень вне 1–4, near:false, пустые исключения.
  assert.deepEqual(cleanSearchArgs({query:"x",price_level_min:9,near:false,exclude_ids:[]}),{query:"x"});
  // min больше max — противоречие; оставляем верхнюю границу.
  assert.deepEqual(cleanSearchArgs({query:"x",price_level_min:4,price_level_max:2}),{query:"x",price_level_max:2});
});

test("поиск из разговора: «ещё» исключает показанное, позиция и время подставляются", async () => {
  const calls=[];
  const search=async(a)=>{calls.push(a);return {results:a.exclude_ids&&a.query==="Zuma"?[]:[{id:"n1"}]}};
  const ctx={user_location:{lat:55.75,lon:37.61},taste_weights:{quiet:1}};
  await dialogueRecommend({query:"bar"},{message:"show me more",shown:["s1","s2"],context:ctx,search});
  assert.deepEqual(calls[0].exclude_ids,["s1","s2"]);
  assert.deepEqual(calls[0].user_location,{lat:55.75,lon:37.61});
  assert.deepEqual(calls[0].taste_weights,{quiet:1});
  // Модель сама передала исключения — объединяем с показанным.
  calls.length=0;
  await dialogueRecommend({query:"bar",exclude_ids:["m1"]},{message:"bar",shown:["s1"],context:{},search});
  assert.deepEqual(calls[0].exclude_ids,["m1","s1"]);
  // Обычный запрос — без исключений.
  calls.length=0;
  await dialogueRecommend({query:"bar"},{message:"bar nearby",shown:["s1"],context:{},search});
  assert.equal(calls[0].exclude_ids,undefined);
  // Сами исключили, и ничего не осталось — повторяем без исключений.
  calls.length=0;
  const out=await dialogueRecommend({query:"Zuma"},{message:"another Zuma",shown:["z1"],context:{},search});
  assert.equal(calls.length,2);assert.equal(calls[1].exclude_ids,undefined);assert.equal(out.results.length,1);
  // Запрос без query берёт реплику человека; прошедшее время сдвигается.
  calls.length=0;
  const asked={after_time:"00:01",target_date:cityDate()};
  await dialogueRecommend(asked,{message:"бар",context:{},search});
  assert.equal(calls[0].query,"бар");
  // Время к «сейчас» приводит normalizeWhen (её правила проверены выше).
  const want=normalizeWhen(asked);
  assert.equal(calls[0].after_time,want.after_time);assert.equal(calls[0].target_date,want.target_date);
});

test("последняя известная позиция переживает реплику без координат", () => {
  assert.deepEqual(knownLocation({user_id:777,user_location:{lat:"55.7",lon:"37.6"}},"c1"),{lat:55.7,lon:37.6});
  assert.deepEqual(knownLocation({user_id:777},"c2"),{lat:55.7,lon:37.6});
  assert.equal(knownLocation({user_id:778},"c3"),null);
  assert.equal(knownLocation({user_location:{lat:"x",lon:1}},null),null);
});

test("Москва: подсказка знает дату, инструменты прежние, сводка с id и бронью", () => {
  const s=agentSystem({voice:true});
  assert.match(s,/Сейчас в Москве: (понедельник|вторник|среда|четверг|пятница|суббота|воскресенье), \d{1,2} [а-я]+ \d{4}, \d\d:\d\d \(Europe\/Moscow\)/);
  assert.ok(s.includes(`Сегодня = ${cityDate()}`));
  assert.ok(s.includes(addDays(cityDate(),1)));
  const rec=agentTools().find(t=>t.name==="recommend_free");
  assert.ok(rec.args.max_price_rub,"у Москвы бюджет в рублях остаётся");
  const plan=agentTools().find(t=>t.name==="plan_evening");
  for(const k of ["target_date","party_size","max_price_rub"])assert.ok(plan.args[k],`plan_evening.${k}`);
  const out=JSON.parse(toolResultForAgent("recommend_free",{results:[
    {id:"kudago:1",name:"Концерт",category:"Концерт",kind:"event",date:"2026-10-03",time:"19:30",times:["19:30","22:00"],booking_kind:"tickets",booking_provider:"KudaGo",reasons:["концерт"]},
    {id:"osm:2",name:"Бар",category:"Бар",time:"до 02:00",phone:"+7 999"}
  ]}));
  const [ev,bar]=out.места;
  assert.equal(ev.id,"kudago:1");assert.equal(ev.тип,"event");assert.equal(ev.дата,"2026-10-03");assert.equal(ev.время,"19:30, 22:00");
  assert.equal(ev.бронь,"tickets");assert.equal(ev.бронь_через,"KudaGo");assert.equal(ev.часы,undefined);
  assert.equal(bar.тип,undefined);assert.equal(bar.часы,"до 02:00");assert.equal(bar.есть_телефон,true);
  assert.ok(!JSON.stringify(out).includes("null"));
  assert.match(nowLine({now:EVENING,weather:{temperature_c:7.6,rain:true}}),/Погода сейчас: \+8°C, дождь/);
});

// ---- Дубай: отдельный процесс ----
const ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
const url=(f)=>JSON.stringify(new URL(`../${f}`,import.meta.url).href);
const SCRIPT=`
const {CITY,cityDate}=await import(${url("city.mjs")});
const ag=await import(${url("agent.mjs")});
const sv=await import(${url("server.mjs")});
const out={city:CITY.id,today:cityDate()};
out.voice=ag.agentSystem({voice:true,context:"{}"});
out.tools=ag.agentTools();
out.claude=sv.dialogueTools();
out.claudeSystem=sv.dialogueSystem({selected_place:{id:"osm:7",name:"Zuma",booking_kind:"reserve",booking_provider:"SevenRooms"}});
const saved=CITY.providers.events;
CITY.providers.events=[];
out.noEvents={agent:ag.agentSystem({}),claude:sv.dialogueTools()[0].description,rules:sv.dialogueSystem({})[0].text};
CITY.providers.events=["dubai_events"];
out.withEvents={agent:ag.agentSystem({}),claude:sv.dialogueTools()[0].description,rules:sv.dialogueSystem({})[0].text};
CITY.providers.events=saved;
out.ramadan=ag.nowLine({now:new Date("2027-02-20T18:35:00Z"),weather:{temperature_c:24.4,rain:false}});
out.summer=ag.nowLine({now:new Date("2026-07-03T08:00:00Z")});
out.result=JSON.parse(ag.toolResultForAgent("recommend_free",{results:[
  {id:"g:zuma",name:"Zuma",category:"Japanese restaurant",price:"$$$$ · luxury",price_level:4,michelin:"1 Star",status_note:"temporarily closed",
   booking_kind:"reserve",booking_provider:"SevenRooms",booking_url:"https://x",menu_url:"https://m",reasons:["open now","nearby"],time:"Mo-Su 12:00-01:00"},
  {id:"ev:1",name:"Jazz night",category:"Concert",kind:"event",date:"2026-10-03",time:"21:00",times:["21:00"],booking_kind:"tickets",booking_provider:"Platinumlist",price:"from 150 AED"}
]}));
const {id}=sv.sharePlan({stops:[{slot_start:"19:00",slot_end:"20:00",place:{name:"A"}}],total:{start:"19:00",end:"20:00"}},{});
out.sharedTitle=sv.store.getShared(id).title;
process.stdout.write(JSON.stringify(out));
`;
let DUBAI=null;
function dubai(){
  if(!DUBAI)DUBAI=JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",SCRIPT],
    {cwd:ROOT,env:{...process.env,CITY:"dubai",NODE_ENV:"test"},encoding:"utf8",maxBuffer:32*1024*1024}));
  return DUBAI;
}

test("Дубай: подсказка знает дату и время города — сервер, а не клиент", () => {
  const r=dubai();
  assert.equal(r.city,"dubai");
  const re=/Now in Dubai: (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}, \d\d:\d\d \(Asia\/Dubai, weekend is Sat–Sun\)/;
  assert.match(r.voice,re);
  assert.ok(r.voice.includes(`Today = ${r.today}`));
  // Claude: «сейчас» в изменчивом блоке, не в кешируемом.
  assert.match(r.claudeSystem[1].text,re);
  assert.ok(!re.test(r.claudeSystem[0].text));
  assert.ok(r.claudeSystem[0].cache_control);
  assert.match(r.claudeSystem[1].text,/"booking_provider":"SevenRooms"/);
  assert.match(r.ramadan,/Saturday 20 Feb 2027, 22:35/);
  assert.match(r.ramadan,/Ramadan/);assert.match(r.ramadan,/Weather now: 24°C, no rain/);
  assert.match(r.summer,/Summer heat/);assert.ok(!/Ramadan/.test(r.summer));
});

test("Дубай: схемы инструментов — near, exclude_ids, price_level_*; бюджет в рублях только у Москвы", () => {
  const r=dubai();
  const rec=r.tools.find(t=>t.name==="recommend_free"),plan=r.tools.find(t=>t.name==="plan_evening");
  for(const k of ["near","exclude_ids","price_level_max","price_level_min","target_date","after_time","party_size"])assert.ok(rec.args[k],`yandex recommend.${k}`);
  for(const k of ["near","price_level_max","price_level_min","target_date","party_size","start_time"])assert.ok(plan.args[k],`yandex plan.${k}`);
  assert.equal(rec.args.max_price_rub,undefined);assert.equal(plan.args.max_price_rub,undefined);
  const [crec,cplan]=r.claude;
  const p=crec.input_schema.properties,q=cplan.input_schema.properties;
  assert.equal(p.near.type,"boolean");assert.equal(q.near.type,"boolean");
  assert.equal(p.exclude_ids.type,"array");
  for(const s of [p,q])for(const k of ["price_level_max","price_level_min"]){
    assert.equal(s[k].type,"integer");assert.equal(s[k].minimum,1);assert.equal(s[k].maximum,4);
  }
  assert.equal(p.max_price_rub,undefined);assert.equal(q.max_price_rub,undefined);
  assert.ok(q.target_date&&q.party_size);
  // Правила для обоих движков: «ещё», цены, кнопки карточек, местный контекст.
  for(const text of [r.voice,r.noEvents.rules]){
    assert.match(text,/exclude_ids/);assert.match(text,/price_level_min 3/);
    assert.match(text,/Tap Book on <booking_provider>/);assert.match(text,/Tap Careem or Uber/);assert.match(text,/Tap Directions/);
    assert.match(text,/Sat–Sun/);assert.match(text,/brunch/);assert.match(text,/licensed/);assert.match(text,/dress code/);
    assert.match(text,/Ramadan/);assert.match(text,/Metro/);
    assert.match(text,/why_matched/);assert.match(text,/closest/);
  }
});

test("Дубай: текст про афишу переключается по CITY.providers.events", () => {
  const r=dubai();
  for(const t of [r.noEvents.agent,r.noEvents.claude,r.noEvents.rules]){
    assert.match(t,/no event (line-up|listing)/,t.slice(0,200));
    assert.ok(!/kids' events/.test(t));
  }
  for(const t of [r.withEvents.agent,r.withEvents.claude,r.withEvents.rules]){
    assert.match(t,/concerts, shows, nightlife, kids' events/);
    assert.ok(!/no event (line-up|listing)/.test(t));
  }
  // В любом случае: не выдумывать, событие — только kind "event".
  for(const t of [r.noEvents.agent,r.withEvents.agent,r.noEvents.rules,r.withEvents.rules])
    assert.match(t,/only kind "event" items are events/);
});

test("Дубай: модели уходят id, бронь, мишлен, статус, цена; причины — как подсказка", () => {
  const [zuma,ev]=dubai().result.places;
  assert.equal(zuma.id,"g:zuma");assert.equal(zuma.price,"$$$$ · luxury");assert.equal(zuma.price_level,4);
  assert.equal(zuma.michelin,"1 Star");assert.equal(zuma.status_note,"temporarily closed");
  assert.equal(zuma.booking_kind,"reserve");assert.equal(zuma.booking_provider,"SevenRooms");assert.equal(zuma.has_menu,true);
  assert.deepEqual(zuma.why_matched,["open now","nearby"]);assert.equal(zuma.why,undefined);
  assert.equal(zuma.kind,undefined);assert.equal(zuma.hours,"Mo-Su 12:00-01:00");
  assert.equal(ev.kind,"event");assert.equal(ev.date,"2026-10-03");assert.equal(ev.time,"21:00");
  assert.equal(ev.booking_kind,"tickets");assert.equal(ev.price,"from 150 AED");
});

test("Дубай: общий план по умолчанию называется по-английски", () => {
  assert.equal(dubai().sharedTitle,"Evening with FREE");
});
