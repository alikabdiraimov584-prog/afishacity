import test from "node:test";
import assert from "node:assert/strict";
import {openStore} from "../store.mjs";

test("чужой X-Free-Client не даёт доступ к аккаунту Telegram", () => {
  const s=openStore(":memory:");
  const victim=s.user({tg_id:1001,anon_id:"victim-anon-id-0001",first_name:"Жертва"});
  s.updateProfile(victim.id,{saved:[{id:"a",name:"Личное место"}]});
  // Первый вход злоумышленника со своим Telegram, но с подставленным чужим клиентом.
  const attacker=s.user({tg_id:2002,anon_id:"victim-anon-id-0001",first_name:"Чужой"});
  assert.notEqual(attacker.id,victim.id,"аккаунт захвачен");
  assert.deepEqual(s.getProfile(attacker.id).saved,[],"чужое сохранённое видно");
  assert.equal(s.user({tg_id:1001}).id,victim.id,"владелец потерял свой аккаунт");
  assert.deepEqual(s.getProfile(victim.id).saved,[{id:"a",name:"Личное место"}]);
});

test("штатная привязка анонимной истории к Telegram работает", () => {
  const s=openStore(":memory:");
  const anon=s.user({anon_id:"fresh-anon-000000001"});
  s.updateProfile(anon.id,{saved:[{id:"b",name:"Моё"}]});
  const linked=s.user({tg_id:3003,anon_id:"fresh-anon-000000001"});
  assert.equal(linked.id,anon.id,"история не перенеслась");
  assert.deepEqual(s.getProfile(linked.id).saved,[{id:"b",name:"Моё"}]);
  assert.equal(s.user({tg_id:3003,anon_id:"fresh-anon-000000001"}).id,anon.id,"повторный вход");
});

test("занятый анонимный идентификатор не роняет запрос", () => {
  const s=openStore(":memory:");
  s.user({tg_id:1,anon_id:"taken-anon-00000001"});
  // Раньше здесь падало на уникальном индексе users.anon_id.
  const other=s.user({tg_id:2,anon_id:"taken-anon-00000001"});
  assert.ok(other&&other.id,"запрос завершился ошибкой");
  assert.equal(other.anon_id,null,"чужой идентификатор присвоен");
});

test("ссылка с опасной схемой не попадает на страницу плана", async () => {
  const {readFileSync}=await import("node:fs");
  const src=readFileSync(new URL("../server.mjs",import.meta.url),"utf8");
  const m=src.match(/function safeHref\(raw\)\{[\s\S]*?\n\}/);
  assert.ok(m,"safeHref не найдена");
  const safeHref=new Function("return "+m[0])();
  for(const bad of ["javascript:alert(1)","JaVaScRiPt:alert(1)","data:text/html,<script>","vbscript:x","//evil.com","",null])
    assert.equal(safeHref(bad),"",String(bad));
  for(const good of ["https://example.com/x","http://example.com","tel:+79990000000","mailto:a@b.c","/p/abc"])
    assert.equal(safeHref(good),good,good);
});

test("ссылка из тегов OpenStreetMap проверяется по схеме", async () => {
  const {safeLink}=await import("../providers.mjs");
  for(const bad of ["javascript:alert(1)","data:text/html,x","ftp://a/b","мусор",""])
    assert.equal(safeLink(bad),null,String(bad));
  assert.equal(safeLink("https://rovesnik.bar/"),"https://rovesnik.bar/");
});

test("тело запроса обязано быть объектом", async () => {
  const {readFileSync}=await import("node:fs");
  const src=readFileSync(new URL("../server.mjs",import.meta.url),"utf8");
  // «null», «42» и «[1,2]» — валидный JSON, но не объект: обращение к полю
  // бросало TypeError и отдавало 500. Разбор идёт через общую проверку формы.
  assert.equal(/JSON\.parse\(await readBody\(/.test(src),false,"остался разбор без проверки формы");
  assert.ok(src.includes("async function readJsonObject"),"общая проверка формы не найдена");
  const m=src.match(/async function readJsonObject\(req,max\)\{[\s\S]*?\n\}/);
  const readJsonObject=new Function("readBody","return "+m[0])(async()=>globalThis.__body);
  for(const bad of ["null","42","[1,2]",'"строка"',"true"]){
    globalThis.__body=bad;
    await assert.rejects(()=>readJsonObject({},1000),SyntaxError,bad);
  }
  globalThis.__body='{"query":"бар"}';
  assert.deepEqual(await readJsonObject({},1000),{query:"бар"});
  globalThis.__body="";
  assert.deepEqual(await readJsonObject({},1000),{},"пустое тело — пустой объект");
});

test("поле-объект вместо строки отвергается, а не роняет запрос", async () => {
  const {rankLive}=await import("../live_ranker.mjs");
  const {buildSearchPlan,parseMoney,safeLink,wantsCenter}=await import("../providers.mjs");
  // {"toString":1} — валидный JSON, и String() на нём бросает
  // «Cannot convert object to primitive value». Одного такого поля хватало,
  // чтобы запрос завершился пятисоткой с внутренним текстом ошибки наружу.
  const poison=[{toString:1},{valueOf:{}},Object.create(null),[{},{}],{toString(){throw new Error("бах")}}];
  for(const bad of poison){
    const args={query:bad,area:bad,after_time:bad,target_date:bad,taste_weights:bad};
    assert.doesNotThrow(()=>rankLive([],args,buildSearchPlan(args)),`ранкер на ${JSON.stringify(bad)}`);
    assert.doesNotThrow(()=>parseMoney(bad));
    assert.doesNotThrow(()=>safeLink(bad));
    assert.doesNotThrow(()=>wantsCenter(bad));
    assert.equal(safeLink(bad),null,"нестрока ссылкой быть не может");
    assert.equal(parseMoney(bad),null,"нестрока ценой быть не может");
  }
});

test("кеш картинок вытесняет по объёму, а не только по числу файлов", async () => {
  const {writeImgCache,pruneImgCache,readImgCache}=await import("../server.mjs");
  const {mkdtempSync,rmSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const dir=mkdtempSync(join(tmpdir(),"free-img-b-"));
  let t=1_000_000;const now=()=>t;
  try{
    // Счёт файлов ничего не говорит о занятом месте: четыре тысячи картинок
    // по три мегабайта — двенадцать гигабайт на диске.
    const big=Buffer.alloc(50_000,1);
    for(let i=0;i<10;i++){t+=1000;writeImgCache("https://x/"+i,"image/jpeg",big,{dir,now})}
    assert.ok(pruneImgCache({dir,now,max:1000,maxBytes:200_000})>0,"по объёму должно вытеснять");
    let left=0;for(let i=0;i<10;i++)if(readImgCache("https://x/"+i,{dir,now}))left++;
    assert.ok(left<=4,`осталось ${left} — должно уместиться в предел`);
    assert.ok(readImgCache("https://x/9",{dir,now}),"свежее остаётся");
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test("прокси картинок не отдаёт SVG и запрещает исполнение", async () => {
  const {readImgCache,writeImgCache}=await import("../server.mjs");
  const {mkdtempSync,rmSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const dir=mkdtempSync(join(tmpdir(),"free-img-s-"));
  const now=()=>1_000_000;
  try{
    // SVG — документ со скриптами: отданный с нашего адреса, он выполнялся бы
    // в нашем origin. Из кеша такой тип тоже не должен возвращаться.
    writeImgCache("https://evil/x.svg","image/svg+xml",Buffer.from("<svg onload=alert(1)>"),{dir,now});
    assert.equal(readImgCache("https://evil/x.svg",{dir,now}),null);
    writeImgCache("https://ok/x.jpg","image/jpeg",Buffer.from("JPEG"),{dir,now});
    assert.ok(readImgCache("https://ok/x.jpg",{dir,now}),"растровое отдаётся");
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test("кеш картинок: попадание, срок, уборка", async () => {
  const {readImgCache,writeImgCache,pruneImgCache}=await import("../server.mjs");
  const {mkdtempSync,rmSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const dir=mkdtempSync(join(tmpdir(),"free-img-"));
  let t=1_000_000;const now=()=>t;
  try{
    // Прокси ходил за кадром заново на каждый показ карточки.
    assert.equal(readImgCache("https://x/a.jpg",{dir,now}),null,"пусто до записи");
    assert.equal(writeImgCache("https://x/a.jpg","image/jpeg",Buffer.from("JPEG"),{dir,now}),true);
    const hit=readImgCache("https://x/a.jpg",{dir,now});
    assert.equal(hit.type,"image/jpeg");assert.equal(hit.body.toString(),"JPEG");
    assert.equal(readImgCache("https://x/b.jpg",{dir,now}),null,"другой адрес — другой ключ");
    t+=8*24*3600e3;                                        // неделя прошла
    assert.equal(readImgCache("https://x/a.jpg",{dir,now}),null,"просроченное не отдаём");
    assert.equal(pruneImgCache({dir,now}),1,"просроченное убирается с диска");
    // Переполнение: остаются самые свежие.
    for(let i=0;i<6;i++){t+=1000;writeImgCache("https://x/"+i,"image/png",Buffer.from("p"),{dir,now})}
    assert.equal(pruneImgCache({dir,now,max:4}),2);
    assert.equal(readImgCache("https://x/0",{dir,now}),null,"самое старое вытеснено");
    assert.ok(readImgCache("https://x/5",{dir,now}),"свежее на месте");
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test("ключ лимитов нельзя выбрать себе самому", async () => {
  // nginx ставит X-Forwarded-For через $proxy_add_x_forwarded_for — то есть
  // дописывает настоящий адрес к тому, что прислал клиент. Первый элемент
  // списка принадлежит клиенту, и брать его значило позволить выбирать себе
  // счётчик: новый выдуманный адрес на каждый запрос — лимита нет вовсе.
  // А лимит диалогов сторожит расход ключа Yandex, то есть деньги.
  const {clientKey}=await import("../server.mjs");
  const req=(headers)=>({socket:{remoteAddress:"127.0.0.1"},headers});

  assert.equal(clientKey(req({"x-real-ip":"203.0.113.9"})),"203.0.113.9","адрес ставит прокси, не клиент");
  assert.equal(
    clientKey(req({"x-real-ip":"203.0.113.9","x-forwarded-for":"1.1.1.1, 203.0.113.9"})),
    "203.0.113.9","подставленное начало цепочки игнорируется");
  assert.equal(
    clientKey(req({"x-forwarded-for":"9.9.9.9, 203.0.113.9"})),
    "203.0.113.9","без X-Real-IP берём хвост цепочки — его дописал прокси");

  // Мусор в заголовке не должен становиться ключом: каждая уникальная строка
  // заводит запись в таблице лимитов на десять минут.
  for(const junk of ["x".repeat(5000),"не адрес","<script>",""])
    assert.equal(clientKey(req({"x-real-ip":junk})),"127.0.0.1",`«${junk.slice(0,12)}» не адрес`);

  // Соединение не от своего прокси — заголовкам не верим вовсе.
  assert.equal(
    clientKey({socket:{remoteAddress:"198.51.100.4"},headers:{"x-real-ip":"203.0.113.9"}}),
    "198.51.100.4");
});

test("выдуманные адреса не плодят счётчики без конца", async () => {
  const {clientKey}=await import("../server.mjs");
  const keys=new Set();
  for(let i=0;i<1000;i++)
    keys.add(clientKey({socket:{remoteAddress:"127.0.0.1"},
      headers:{"x-forwarded-for":`10.0.0.${i%256}, 203.0.113.9`}}));
  assert.equal(keys.size,1,"тысяча подделок — один счётчик, а не тысяча записей в памяти");
});
