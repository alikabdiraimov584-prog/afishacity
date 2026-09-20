// Клиент Yandex Cloud. Сеть в тестах подменяется: проверяем форму запроса,
// разбор ответа и — главное — что ошибки не проглатываются, а называются.
import test from "node:test";
import assert from "node:assert/strict";
import {yandexComplete,yandexStt,yandexTts,yandexConfig,modelUri,yandexStatus,YandexError,STT_MAX_BYTES} from "../yandex.mjs";

const CFG={key:"test-key",folder:"b1gfolder",ready:true,model:"yandexgpt/latest",
  voice:"alena",emotion:"good",temperature:0.3,maxTokens:1500};
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
  assert.deepEqual(yandexStatus({}),{ready:false,has_key:false,has_folder:false,model:null,voice:"alena"});
  const s=yandexStatus({YANDEX_API_KEY:"k",YANDEX_FOLDER_ID:"f",YANDEX_VOICE:"filipp"});
  assert.equal(s.ready,true);
  assert.equal(s.model,"gpt://f/yandexgpt/latest");
  assert.equal(s.voice,"filipp");
  assert.deepEqual(yandexStatus({YANDEX_API_KEY:"k"}),
    {ready:false,has_key:true,has_folder:false,model:null,voice:"alena"},"видно, чего именно не хватает");
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
