// Клиент Yandex Cloud. Сеть в тестах подменяется: проверяем форму запроса,
// разбор ответа и — главное — что ошибки не проглатываются, а называются.
import test from "node:test";
import assert from "node:assert/strict";
import {yandexComplete,yandexStt,yandexTts,yandexConfig,modelUri,yandexStatus,YandexError,STT_MAX_BYTES,
  parseV3Audio,V3_ONLY_VOICES,resetTtsEngine,ttsEngineState} from "../yandex.mjs";

const CFG={key:"test-key",folder:"b1gfolder",ready:true,model:"yandexgpt/latest",
  voice:"alena",emotion:"good",temperature:0.3,maxTokens:1500,ttsVersion:"v1"};
const ok=(body)=>({ok:true,status:200,json:async()=>body,arrayBuffer:async()=>new TextEncoder().encode("audio").buffer});
const fail=(status,body)=>({ok:false,status,json:async()=>body,text:async()=>JSON.stringify(body)});
const reply=(text)=>({result:{alternatives:[{message:{role:"assistant",text},status:"ALTERNATIVE_STATUS_FINAL"}],
  usage:{totalTokens:"42"},modelVersion:"23.10"}});

test("URI модели собирается из каталога либо берётся целиком", () => {
  assert.equal(modelUri(CFG),"gpt://b1gfolder/yandexgpt/latest");
  assert.equal(modelUri({...CFG,model:"gpt://other/yandexgpt-lite/rc"}),"gpt://other/yandexgpt-lite/rc");
});

test("запрос к модели уходит в ожидаемой форме", async () => {
  let seen=null;
  const fetchImpl=async(url,init)=>{seen={url,init};return ok(reply("Привет"))};
  const r=await yandexComplete([{role:"system",text:"ты консьерж"},{role:"user",text:"бар"}],{cfg:CFG,fetchImpl});
  assert.equal(r.text,"Привет");
  assert.equal(seen.init.headers.Authorization,"Api-Key test-key");
  assert.equal(seen.init.headers["x-folder-id"],"b1gfolder");
  const body=JSON.parse(seen.init.body);
  assert.equal(body.modelUri,"gpt://b1gfolder/yandexgpt/latest");
  assert.equal(body.completionOptions.stream,false);
  assert.equal(body.completionOptions.maxTokens,"1500");
  assert.deepEqual(body.messages,[{role:"system",text:"ты консьерж"},{role:"user",text:"бар"}]);
});

test("пустой ответ модели считается сбоем, а не репликой", async () => {
  const fetchImpl=async()=>ok(reply("   "));
  await assert.rejects(()=>yandexComplete([{role:"user",text:"а"}],{cfg:CFG,fetchImpl}),
    (e)=>e instanceof YandexError&&e.retryable&&/пустой ответ/.test(e.message));
});

test("ошибки называются понятно и различают повторяемые", async () => {
  const cases=[
    [401,{error:{message:"unauthorized"}},/Ключ Yandex Cloud не принят/,false],
    [403,{message:"forbidden"},/Ключ Yandex Cloud не принят/,false],
    [404,{error:{message:"model not found"}},/Модель или каталог не найдены/,false],
    [429,{message:"too many"},/Превышен лимит/,true],
    [503,{},/Yandex Cloud ответил 503/,true]
  ];
  for(const [status,body,re,retryable] of cases){
    const fetchImpl=async()=>fail(status,body);
    await assert.rejects(()=>yandexComplete([{role:"user",text:"а"}],{cfg:CFG,fetchImpl}),
      (e)=>{assert.ok(re.test(e.message),`${status}: ${e.message}`);assert.equal(e.retryable,retryable,`${status} повторяемость`);return true});
  }
});

test("без ключа и каталога запрос не уходит вовсе", async () => {
  let called=false;
  const fetchImpl=async()=>{called=true;return ok(reply("х"))};
  await assert.rejects(()=>yandexComplete([{role:"user",text:"а"}],{cfg:{...CFG,ready:false},fetchImpl}),
    /не настроен/);
  assert.equal(called,false,"в сеть ходить незачем, если настроек нет");
});

test("распознавание речи: параметры и предел длины", async () => {
  let seen=null;
  const fetchImpl=async(url,init)=>{seen={url,init};return ok({result:"хочу выпить"})};
  const text=await yandexStt(Buffer.alloc(1000),{cfg:CFG,fetchImpl});
  assert.equal(text,"хочу выпить");
  const u=new URL(seen.url);
  assert.equal(u.searchParams.get("format"),"lpcm");
  assert.equal(u.searchParams.get("sampleRateHertz"),"16000");
  assert.equal(u.searchParams.get("lang"),"ru-RU");
  assert.equal(u.searchParams.get("folderId"),"b1gfolder");
  await assert.rejects(()=>yandexStt(Buffer.alloc(0),{cfg:CFG,fetchImpl}),/Пустая запись/);
  await assert.rejects(()=>yandexStt(Buffer.alloc(STT_MAX_BYTES+1),{cfg:CFG,fetchImpl}),/тридцати секунд/);
});

test("синтез речи отдаёт mp3 и обрезает слишком длинный текст", async () => {
  let seen=null;
  const fetchImpl=async(url,init)=>{seen={url,init};return ok({})};
  const buf=await yandexTts("Нашёл три бара рядом",{cfg:CFG,fetchImpl});
  assert.ok(Buffer.isBuffer(buf)&&buf.length>0);
  const form=new URLSearchParams(seen.init.body);
  assert.equal(form.get("format"),"mp3","Safari не везде играет Ogg Opus");
  assert.equal(form.get("voice"),"alena");
  assert.equal(form.get("emotion"),"good");
  assert.equal(form.get("lang"),"ru-RU");
  const long=await yandexTts("а".repeat(9000),{cfg:CFG,fetchImpl});
  assert.ok(Buffer.isBuffer(long));
  assert.equal(new URLSearchParams(seen.init.body).get("text").length,5000);
  await assert.rejects(()=>yandexTts("   ",{cfg:CFG,fetchImpl}),/Нечего произносить/);
});

test("состояние настроек видно до первого разговора", () => {
  assert.deepEqual(yandexStatus({}),{ready:false,has_key:false,has_folder:false,model:null,voice:"masha"});
  const s=yandexStatus({YANDEX_API_KEY:"k",YANDEX_FOLDER_ID:"f",YANDEX_VOICE:"zahar"});
  assert.equal(s.ready,true);
  assert.equal(s.model,"gpt://f/yandexgpt/latest");
  assert.equal(s.voice,"zahar","настройка голоса перебивает умолчание");
  assert.deepEqual(yandexStatus({YANDEX_API_KEY:"k"}),
    {ready:false,has_key:true,has_folder:false,model:null,voice:"masha"},"видно, чего именно не хватает");
});

test("обрыв по таймауту сообщается как повторяемая ошибка", async () => {
  const fetchImpl=async(_u,init)=>new Promise((_r,rej)=>{
    init.signal.addEventListener("abort",()=>rej(Object.assign(new Error("aborted"),{name:"AbortError"})));
  });
  await assert.rejects(()=>yandexComplete([{role:"user",text:"а"}],{cfg:CFG,fetchImpl,timeoutMs:20}),
    (e)=>e instanceof YandexError&&e.retryable&&/не ответил вовремя/.test(e.message));
});

test("настройки читаются из окружения", () => {
  const cfg=yandexConfig({YANDEX_API_KEY:"k",YANDEX_FOLDER_ID:"f",YANDEX_MODEL:"yandexgpt-lite/latest",
    YANDEX_TEMPERATURE:"0.7",YANDEX_MAX_TOKENS:"900"});
  assert.equal(cfg.ready,true);
  assert.equal(cfg.temperature,0.7);
  assert.equal(cfg.maxTokens,900);
  assert.equal(modelUri(cfg),"gpt://f/yandexgpt-lite/latest");
});

// ---- Скорость разговора ----
// Живой разговор: «думал три секунды». За ход агент ходит к модели дважды,
// и на старшей модели каждая ходка стоит секунду с лишним.

test("вслух берётся быстрая модель и короткий потолок ответа", async () => {
  let seen=null;
  const fetchImpl=async(u,init)=>{seen=JSON.parse(init.body);return ok(reply("да"))};
  const cfg=yandexConfig({YANDEX_API_KEY:"k",YANDEX_FOLDER_ID:"f"});
  await yandexComplete([{role:"user",text:"бар"}],{cfg,fetchImpl,voice:true});
  assert.equal(seen.modelUri,"gpt://f/yandexgpt-lite/latest","вслух — быстрая модель");
  assert.equal(seen.completionOptions.maxTokens,"220","вслух реплика короткая по определению");

  await yandexComplete([{role:"user",text:"бар"}],{cfg,fetchImpl,voice:false});
  assert.equal(seen.modelUri,"gpt://f/yandexgpt/latest","в переписке остаётся старшая модель");
  assert.equal(seen.completionOptions.maxTokens,"1500");
});

test("обе модели настраиваются отдельно", () => {
  const cfg=yandexConfig({YANDEX_API_KEY:"k",YANDEX_FOLDER_ID:"f",
    YANDEX_MODEL:"yandexgpt-32k/latest",YANDEX_VOICE_MODEL:"yandexgpt-lite/rc"});
  assert.equal(modelUri(cfg,{voice:true}),"gpt://f/yandexgpt-lite/rc");
  assert.equal(modelUri(cfg),"gpt://f/yandexgpt-32k/latest");
});

test("скорость речи берётся из настроек, а не прибита единицей", async () => {
  let body=null;
  const fetchImpl=async(u,init)=>{body=new URLSearchParams(init.body);return {ok:true,status:200,arrayBuffer:async()=>new ArrayBuffer(8)}};
  await yandexTts("привет",{cfg:yandexConfig({YANDEX_API_KEY:"k",YANDEX_FOLDER_ID:"f",YANDEX_TTS_VERSION:"v1",YANDEX_VOICE:"filipp"}),fetchImpl});
  assert.equal(body.get("speed"),"1.08","чуть быстрее обычного: медленная речь слушается как задумчивость");
  await yandexTts("привет",{cfg:yandexConfig({YANDEX_API_KEY:"k",YANDEX_FOLDER_ID:"f",YANDEX_TTS_VERSION:"v1",YANDEX_VOICE:"filipp",YANDEX_SPEED:"1.3"}),fetchImpl});
  assert.equal(body.get("speed"),"1.3");
});

// ---- Третья версия синтеза ----
// Молодые голоса (alexander, kirill, anton, masha…) существуют только в v3,
// и там же есть роли — манера звучания, которая меняет возраст голоса сильнее
// самого тембра.

const V3CFG={...CFG,ttsVersion:"auto",voice:"alexander",speed:1.08,role:""};
const v3line=(...b64)=>b64.map(d=>JSON.stringify({result:{audioChunk:{data:d}}})).join("\n");
const okText=(body)=>({ok:true,status:200,text:async()=>body});

test("синтез v3 просит голос, роль и скорость подсказками", async () => {
  resetTtsEngine();
  let seen=null;
  const fetchImpl=async(url,init)=>{seen={url,init};return okText(v3line(Buffer.from("mp3").toString("base64")))};
  const buf=await yandexTts("Ровесник в двух шагах",{cfg:V3CFG,fetchImpl,role:"friendly"});
  assert.match(seen.url,/tts\/v3\/utteranceSynthesis/);
  const body=JSON.parse(seen.init.body);
  assert.deepEqual(body.hints,[{voice:"alexander"},{role:"friendly"},{speed:"1.08"}]);
  assert.equal(body.outputAudioSpec.containerAudio.containerAudioType,"MP3");
  assert.equal(buf.toString(),"mp3");
});

test("поток из нескольких кусков собирается в один файл", async () => {
  resetTtsEngine();
  const parts=["0J/RgA==","0LjQstC10YI="];                 // два куска звука
  const whole=Buffer.concat(parts.map(p=>Buffer.from(p,"base64")));
  const fetchImpl=async()=>okText(v3line(...parts));
  const buf=await yandexTts("привет",{cfg:V3CFG,fetchImpl});
  assert.deepEqual(buf,whole,"звук склеивается по порядку, а не берётся первый кусок");
});

test("разбор терпим к форме обёртки", () => {
  const d=Buffer.from("зв").toString("base64");
  const want=Buffer.from("зв");
  assert.deepEqual(parseV3Audio(JSON.stringify({result:{audioChunk:{data:d}}})),want,"один объект");
  assert.deepEqual(parseV3Audio(JSON.stringify([{result:{audioChunk:{data:d}}}])),want,"массив");
  assert.deepEqual(parseV3Audio(JSON.stringify({audioChunk:{data:d}})),want,"без обёртки result");
  assert.deepEqual(parseV3Audio('{"result":{"audioChunk":{"data":"'+d+'"}}}\n{"result":{}}\n'),want,"строки, часть без звука");
  assert.equal(parseV3Audio("не json"),null);
  assert.equal(parseV3Audio(""),null);
});

test("если v3 недоступен, разговор продолжается на v1 — но один раз", async () => {
  resetTtsEngine();
  let v3calls=0,v1calls=0;
  const fetchImpl=async(url)=>{
    if(String(url).includes("/v3/")){v3calls++;return fail(404,{message:"no such method"})}
    v1calls++;return ok({});
  };
  const cfg={...CFG,ttsVersion:"auto",voice:"filipp",speed:1.0};
  assert.ok((await yandexTts("раз",{cfg,fetchImpl})).length>0,"человек всё равно слышит ответ");
  assert.equal(ttsEngineState().v3_disabled,true);
  await yandexTts("два",{cfg,fetchImpl});
  await yandexTts("три",{cfg,fetchImpl});
  assert.equal(v3calls,1,"в недоступную версию не ходим на каждой реплике");
  assert.equal(v1calls,3);
  resetTtsEngine();
});

test("голос, которого нет в v1, молча не подменяется другим", async () => {
  resetTtsEngine();
  const fetchImpl=async(url)=>String(url).includes("/v3/")?fail(404,{message:"no such method"}):ok({});
  // Выбранный голос — это лицо агента. Подставить вместо него чужой и сделать
  // вид, что всё хорошо, хуже, чем сказать, что не вышло.
  for(const v of V3_ONLY_VOICES){
    await assert.rejects(()=>yandexTts("привет",{cfg:{...CFG,ttsVersion:"auto",voice:v},fetchImpl}));
  }
  assert.equal(ttsEngineState().v3_disabled,false,"чужая ошибка не выключает версию для всех");
  resetTtsEngine();
});

// ---- Подмена голоса ----
// Живой разговор: «сначала говорила Варя, потом обратно Алиса». Выключенная
// третья версия отправляла голос, которого в первой нет, в первую — и та
// молча подставляла свой стандартный.

test("выключенная v3 не повод отдать чужой голос", async () => {
  resetTtsEngine();
  const seen=[];
  const fetchImpl=async(url,init)=>{
    if(String(url).includes("/v3/")){seen.push("v3");return fail(404,{message:"no such method"})}
    seen.push("v1:"+new URLSearchParams(init.body).get("voice"));
    return ok({});
  };
  const cfg={...CFG,ttsVersion:"auto",voice:"filipp",role:"",speed:1.0};
  await yandexTts("раз",{cfg,fetchImpl});                     // filipp есть в v1 — откат законен
  assert.equal(ttsEngineState().v3_disabled,true);

  // А теперь голос, которого в первой версии не существует.
  seen.length=0;
  await assert.rejects(()=>yandexTts("два",{cfg:{...cfg,voice:"masha"},fetchImpl}),
    /недоступен в каталоге/,"молчание честнее чужого голоса");
  assert.ok(!seen.some(x=>x.startsWith("v1:")),`в первую версию masha уходить не должна: ${seen}`);
  resetTtsEngine();
});

test("разовый сбой не лишает агента голоса до перезапуска", async () => {
  resetTtsEngine();
  let n=0;
  // Таймаут, лимит и пятисотка ничего не говорят о наличии версии.
  for(const [status,body] of [[429,{message:"too many"}],[503,{}],[500,{}]]){
    const fetchImpl=async(url)=>String(url).includes("/v3/")?fail(status,body):ok({});
    await assert.rejects(()=>yandexTts("раз",{cfg:{...CFG,ttsVersion:"auto",voice:"filipp",role:""},fetchImpl}));
    assert.equal(ttsEngineState().v3_disabled,false,`${status} не должен выключать версию`);
    n++;
  }
  assert.equal(n,3);
  resetTtsEngine();
});

test("выбранная первая версия с голосом из третьей — понятная ошибка, а не подмена", async () => {
  resetTtsEngine();
  let called=false;
  const fetchImpl=async()=>{called=true;return ok({})};
  await assert.rejects(()=>yandexTts("привет",{cfg:{...CFG,ttsVersion:"v1",voice:"masha"},fetchImpl}),
    /только в третьей версии/);
  assert.equal(called,false,"в сеть ходить незачем: настройки противоречат друг другу");
});
