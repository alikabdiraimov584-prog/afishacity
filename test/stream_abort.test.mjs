// Уход клиента посреди потокового разговора.
//
// Ход агента стоит денег: до четырёх обращений к модели и три обхода
// провайдеров. Если об уходе не узнать, всё это доводится до конца впустую.
import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFileSync} from "node:fs";

/** Поднимает сервер, обрывает запрос на середине и отдаёт, что сработало. */
function watchDisconnect(register){
  return new Promise((done)=>{
    const seen={req:false,res:false,afterBody:null};
    const srv=createServer(async(req,res)=>{
      for await(const c of req);                       // как readJsonObject: дочитываем тело
      seen.afterBody={closed:req.closed,destroyed:req.destroyed};
      register(req,res,seen);
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      res.write("event: ping\ndata: {}\n\n");
      setTimeout(()=>{try{res.end()}catch{};srv.close();done(seen)},250);
    });
    srv.listen(0,()=>{
      const ctrl=new AbortController();
      fetch(`http://127.0.0.1:${srv.address().port}/s`,
        {method:"POST",body:'{"message":"бар"}',signal:ctrl.signal}).catch(()=>{});
      setTimeout(()=>ctrl.abort(),80);                 // человек закрыл приложение
    });
  });
}

test("запрос закрыт сразу после чтения тела — подписка на него мертва", async () => {
  // Проверено на v22.22.2. Именно поэтому req.on("close") в потоковом
  // разговоре не срабатывал ни разу за всю жизнь сервиса.
  const seen=await watchDisconnect((req,_res,s)=>{req.on("close",()=>{s.req=true})});
  assert.equal(seen.afterBody.closed,true,"тело дочитано — запрос уже закрыт");
  assert.equal(seen.req,false,"обработчик на закрытом запросе не сработает никогда");
});

test("ответ об уходе клиента узнаёт честно", async () => {
  const seen=await watchDisconnect((_req,res,s)=>{res.on("close",()=>{s.res=true})});
  assert.equal(seen.res,true,"слушать надо ответ: он живёт до конца передачи");
});

test("оборванное соединение видно по destroyed, а не по writableEnded", async () => {
  // writableEnded отвечает «закончили ли МЫ», а не «слушает ли ОН»: у
  // оборванного соединения он остаётся false, и пинги уходили в мёртвый сокет.
  let after=null;
  await watchDisconnect((_req,res)=>{
    res.on("close",()=>{after={ended:res.writableEnded,destroyed:res.destroyed}});
  });
  assert.equal(after.ended,false,"по writableEnded уход клиента не отличить");
  assert.equal(after.destroyed,true,"destroyed — единственный честный признак");
});

test("потоковый разговор слушает ответ и проверяет destroyed", () => {
  const src=readFileSync(new URL("../server.mjs",import.meta.url),"utf8");
  const at=src.indexOf('url.pathname==="/api/dialogue/stream"');
  const body=src.slice(at,src.indexOf('url.pathname==="/api/recommend"',at));
  assert.ok(!/req\.on\("close"/.test(body),"подписка на запрос здесь не сработает: тело уже дочитано");
  assert.match(body,/res\.on\("close",onClose\)/,"об уходе клиента говорит ответ");
  assert.match(body,/res\.destroyed/,"писать в уничтоженный сокет незачем");
  assert.match(body,/abort\.abort\(\)/,"уход клиента обязан отменять ход агента: он стоит денег");
  assert.ok(!/if\(!res\.writableEnded\)res\.write/.test(body),
    "writableEnded не отличает ушедшего клиента от продолжающегося ответа");
});

test("после ухода клиента новый поиск не начинается", () => {
  // Сигнал доходит до модели, но не до обхода источников: он не прокинут
  // через цепочку провайдеров. Зато не дать обходу начаться можно — а
  // начинается он чаще всего именно после ухода, пока модель думает.
  const src=readFileSync(new URL("../server.mjs",import.meta.url),"utf8");
  const at=src.indexOf("async function runYandexAgent");
  const body=src.slice(at,src.indexOf("store.setConversation",at));
  for(const tool of ["recommend_free","plan_evening"]){
    const from=body.indexOf(tool+":");
    assert.notEqual(from,-1,`инструмента ${tool} нет`);
    assert.match(body.slice(from,from+400),/signal&&signal\.aborted/,
      `${tool} обязан отказаться начинать работу для ушедшего`);
  }
});
