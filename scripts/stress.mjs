#!/usr/bin/env node
// Нагрузочная проверка боевого сервера — и одновременно диагностика «не реагирует».
//
// Отвечает на один вопрос: где именно встаёт. Разница между «процесс мёртв»,
// «процесс жив, но цикл событий заблокирован», «упёрлись в предел памяти» и
// «внешний провайдер не отвечает» снаружи выглядит одинаково — как тишина.
// Поэтому здесь не только время ответов: параллельно снимаются счётчики
// cgroup, по которым видно, душит ли службу systemd и убивало ли её ядро.
//
// Запуск на сервере:
//   node --no-warnings=ExperimentalWarning scripts/stress.mjs
//   node ... scripts/stress.mjs --url=https://afishasity.ru --seconds=20 --peak=40
//   node ... scripts/stress.mjs --dialogue      (платно: тратит ключ Yandex)
//
// Ничего не пишет и не меняет. Только читает.

const args=new Map(process.argv.slice(2).map(a=>{const m=/^--([^=]+)(?:=(.*))?$/.exec(a);return m?[m[1],m[2]??"1"]:[a,"1"]}));
const BASE=String(args.get("url")||"http://127.0.0.1:3000").replace(/\/+$/,"");
const SECONDS=Number(args.get("seconds")||12);
const PEAK=Number(args.get("peak")||24);
const WITH_DIALOGUE=args.has("dialogue");
const SERVICE=String(args.get("service")||"free");
const AS_APP=!args.has("anonymous");            // по умолчанию ходим как настоящее приложение

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

/* ---- подпись, как у настоящего клиента ----------------------------------
   Без неё сервер отвечает 401 на всё, что требует авторизации, и тест меряет
   не работу, а отказ в доступе. Токен бота берём из .env самого сервера —
   тем самым проверяется ровно то, чем живёт приложение: та ли это пара
   «бот в Telegram ↔ токен в настройках». Если их разъехало (например, токен
   перевыпустили), приложение молча перестаёт работать целиком, и увидеть это
   можно только так. */
async function appHeaders(){
  if(!AS_APP)return {};
  try{
    const {readFile}=await import("node:fs/promises");
    const {signInitData}=await import("../telegram.mjs");
    const env=await readFile(new URL("../.env",import.meta.url),"utf8").catch(()=>"");
    const token=(/^TELEGRAM_BOT_TOKEN=(.+)$/m.exec(env)||[])[1]?.trim()
      ||process.env.TELEGRAM_BOT_TOKEN||"";
    if(!token)return {reason:"в .env нет TELEGRAM_BOT_TOKEN"};
    const initData=signInitData({
      auth_date:String(Math.floor(Date.now()/1000)),
      query_id:"stress",
      user:{id:777000001,first_name:"Нагрузка",username:"stress",language_code:"ru"},
    },token);
    return {headers:{"X-Telegram-Init-Data":initData,"X-Free-Client":"stress-test-client-0001"}};
  }catch(e){return {reason:String(e&&e.message||e)}}
}
const pct=(sorted,p)=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]:0;
const ms=(n)=>`${Math.round(n)} мс`;
const mb=(n)=>`${(n/1048576).toFixed(0)} МБ`;

/* ---- счётчики cgroup ----------------------------------------------------
   memory.events считает, сколько раз служба упиралась в свои пределы:
   high — сколько раз её принудительно тормозили ради сброса страниц,
   max  — сколько раз упёрлась в жёсткий предел, oom_kill — сколько раз убили.
   Ненулевой high при живом процессе и есть «работает, но не реагирует». */
async function cgroup(){
  const {readFile}=await import("node:fs/promises");
  const roots=[`/sys/fs/cgroup/system.slice/${SERVICE}.service`,`/sys/fs/cgroup/system.slice/system-${SERVICE}.slice`];
  for(const dir of roots){
    try{
      const num=async(f)=>Number((await readFile(`${dir}/${f}`,"utf8")).trim())||0;
      const events=Object.fromEntries((await readFile(`${dir}/memory.events`,"utf8")).trim().split("\n")
        .map(l=>l.split(" ")).map(([k,v])=>[k,Number(v)||0]));
      const maxRaw=(await readFile(`${dir}/memory.max`,"utf8")).trim();
      return {current:await num("memory.current"),peak:await num("memory.peak").catch(()=>0),
        max:maxRaw==="max"?null:Number(maxRaw),events};
    }catch(_){}
  }
  return null;                                   // не Linux, не systemd или нет прав
}

/* ---- один запрос --------------------------------------------------------
   Таймаут свой: без него зависший запрос молча растворится в ожидании, а
   именно он-то и интересен. */
let AUTH={};                                   // заполняется один раз перед тестом
async function hit(path,{method="GET",body=null,headers={},timeoutMs=20000}={}){
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(),timeoutMs);
  const at=performance.now();
  try{
    const r=await fetch(BASE+path,{method,body,headers:{...AUTH,...headers},signal:ctrl.signal});
    const text=await r.text();                   // дочитываем: иначе меряем заголовки, а не ответ
    return {ok:r.ok,status:r.status,ms:performance.now()-at,bytes:text.length};
  }catch(e){
    return {ok:false,status:e.name==="AbortError"?"таймаут":"нет ответа",ms:performance.now()-at,bytes:0,
      why:String(e&&e.message||e)};
  }finally{clearTimeout(t)}
}

function summarize(name,runs){
  const times=runs.map(r=>r.ms).sort((a,b)=>a-b);
  const by=new Map();
  for(const r of runs)by.set(r.status,(by.get(r.status)||0)+1);
  // 429 считаем отдельно: это не поломка, а сработавший лимит запросов, и в
  // списке отказов он только мешает увидеть настоящие.
  const limited=(by.get(429)||0);
  by.delete(429);
  const bad=runs.filter(r=>r.status!==429&&!r.ok).length;
  return {name,n:runs.length,p50:pct(times,0.5),p95:pct(times,0.95),max:times[times.length-1]||0,
    limited,bad,statuses:[...by].filter(([k])=>k!==200&&k!==204).sort((a,b)=>b[1]-a[1])};
}

/* ---- волна нагрузки -----------------------------------------------------
   Держим постоянное число одновременных запросов, а не фиксированное общее:
   так видно, как сервер ведёт себя под давлением, а не сколько он успел. */
async function wave(path,{concurrency,seconds,...opts}={}){
  const until=performance.now()+seconds*1000;
  const runs=[];
  const worker=async()=>{while(performance.now()<until)runs.push(await hit(path,opts))};
  await Promise.all(Array.from({length:concurrency},worker));
  return runs;
}

const line=(s="")=>console.log(s);
const head=(s)=>{line();line(`\x1b[1m${s}\x1b[0m`)};

(async()=>{
  line(`Нагрузка на ${BASE}: ${SECONDS} с на ступень, пик ${PEAK} одновременных`);
  const app=await appHeaders();
  AUTH=app.headers||{};
  if(AS_APP&&app.headers)line("Ходим как настоящее приложение: подпись Telegram собрана из .env");
  else if(AS_APP)line(`Подпись Telegram собрать не вышло (${app.reason}) — идём без неё`);
  else line("Идём без подписи: проверяем, что видит посторонний");

  // 1. Жив ли вообще. Один запрос с коротким терпением: если сервер мёртв,
  // незачем ждать полную волну, чтобы это выяснить.
  head("1. Отзывается ли сервер");
  const first=await hit("/api/health",{timeoutMs:5000});
  if(!first.ok){
    line(`  НЕТ: ${first.status}${first.why?" — "+first.why:""} за ${ms(first.ms)}`);
    const c=await cgroup();
    if(c)line(`  Память службы: ${mb(c.current)}${c.max?` из ${mb(c.max)}`:""}, убийств по памяти: ${c.events.oom_kill||0}`);
    line();
    line("  Дальше смотреть здесь:");
    line("    systemctl status free --no-pager | tail -20");
    line("    journalctl -u free -n 50 --no-pager");
    process.exit(2);
  }
  line(`  Да, за ${ms(first.ms)}`);

  const before=await cgroup();
  if(before){
    line(`  Память службы сейчас: ${mb(before.current)}${before.max?` из ${mb(before.max)}`
      :" — ПРЕДЕЛ НЕ ЗАДАН: юнит-файл на машине старее репозитория, обнови установщиком"}`);
    if(before.events.oom_kill)line(`  ВНИМАНИЕ: службу уже убивали по памяти ${before.events.oom_kill} раз`);
    if(before.events.high)line(`  ВНИМАНИЕ: службу тормозили ради сброса страниц ${before.events.high} раз`);
  }else line("  Счётчики cgroup недоступны — запусти на сервере от root, чтобы их видеть");

  // 2. Ступени. Одна и та же ручка под растущим давлением: если p95 растёт
  // быстрее, чем число одновременных запросов, упёрлись не в сеть.
  head("2. Ступени нагрузки на /api/health");
  const rows=[];
  // Ступени без повторов: при маленьком пике округления дают одно и то же
  // число дважды, и в отчёте появляются две одинаковые строки.
  const ladder=[...new Set([1,Math.round(PEAK/4),Math.round(PEAK/2),PEAK].map(n=>Math.max(1,n)))].sort((a,b)=>a-b);
  for(const c of ladder){
    const s=summarize(`${c} одновременно`,await wave("/api/health",{concurrency:c,seconds:SECONDS/2,timeoutMs:15000}));
    rows.push({...s,concurrency:c});
    line(`  ${String(c).padStart(3)} → ${String(s.n).padStart(5)} запросов, p50 ${ms(s.p50).padStart(8)}, p95 ${ms(s.p95).padStart(8)}, худший ${ms(s.max)}${s.bad?`, отказов ${s.bad}`:""}`);
  }

  // 3. Тяжёлые пути. Здесь ищем синхронную работу: если цикл событий
  // блокируется, даже /api/health рядом начнёт отвечать медленно.
  head("3. Тяжёлые ручки");
  // Обложку сюда не берём: её адрес подписан, без подписи это проверка 400-го
  // ответа, а не работы. Берём то, что действительно делает работу на запрос.
  const heavy=[
    ["Статика (index.html)","/"],
    ["Скрипт экрана разговора","/voice.js"],
    ["Поиск мест","/api/recommend"],
  ];
  let unauthorized=false;
  for(const [name,path] of heavy){
    const opts=path==="/api/recommend"
      ?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:"бар"}),timeoutMs:30000}
      :{timeoutMs:30000};
    const s=summarize(name,await wave(path,{concurrency:Math.max(2,Math.round(PEAK/4)),seconds:SECONDS/2,...opts}));
    if(s.statuses.some(([k,v])=>k===401&&v>s.n*0.9))unauthorized=true;
    line(`  ${name.padEnd(28)} ${String(s.n).padStart(4)} шт, p50 ${ms(s.p50).padStart(8)}, p95 ${ms(s.p95).padStart(9)}` +
      `${s.limited?`, лимит сработал ${s.limited}`:""}${s.bad?`, ОТКАЗОВ ${s.bad} (${s.statuses.map(([k,v])=>k+"×"+v).join(", ")})`:""}`);
  }

  // 4. Не заблокирован ли цикл событий. Меряем самую дешёвую ручку, пока
  // рядом идёт тяжёлая: в Node всё исполняется в одном потоке, и если тяжёлое
  // сделано синхронно, лёгкое встанет вместе с ним. Это и есть «не реагирует».
  head("4. Не встаёт ли всё разом");
  const idle=summarize("покой",await wave("/api/health",{concurrency:1,seconds:3,timeoutMs:10000}));
  const busy=wave("/api/recommend",{concurrency:Math.max(4,Math.round(PEAK/2)),seconds:SECONDS,
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:"кафе"}),timeoutMs:30000});
  await sleep(400);
  const under=summarize("под нагрузкой",await wave("/api/health",{concurrency:1,seconds:Math.max(3,SECONDS-2),timeoutMs:15000}));
  await busy;
  // Судим по абсолютным числам, а не по отношению. На быстрой машине покой
  // даёт ноль-один миллисекунд, и любое «под нагрузкой стало два» превращается
  // в «замедление в восемь раз» — ложная тревога на делении почти нуля. Важно
  // другое: сколько миллисекунд самая дешёвая ручка ЖДЁТ, пока рядом работают.
  // Заблокированный цикл событий — это сотни миллисекунд, а не единицы.
  const delta=under.p50-idle.p50;
  const blocked=under.p95>=250||under.max>=1000;
  const strained=under.p95>=80||delta>=50;
  line(`  /api/health в покое        p50 ${ms(idle.p50)}, p95 ${ms(idle.p95)}`);
  line(`  /api/health под нагрузкой  p50 ${ms(under.p50)}, p95 ${ms(under.p95)}, худший ${ms(under.max)}`);
  line(`  Задержка от нагрузки: +${ms(delta)} — ${blocked
    ?"цикл событий блокируется, ищи синхронную работу в пути запроса"
    :strained?"заметно, но приложение отвечает":"нормально, дешёвые ручки не ждут тяжёлых"}`);

  // 5. Разговор. По умолчанию выключен: каждый заход стоит денег.
  if(WITH_DIALOGUE){
    head("5. Разговор с агентом (тратит ключ)");
    const d=await hit("/api/dialogue",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:"бар рядом",voice:false}),timeoutMs:90000});
    line(`  ${d.ok?"ответил":"НЕ ОТВЕТИЛ"} за ${ms(d.ms)}, статус ${d.status}, ${d.bytes} байт`);
    if(d.ms>15000)line("  Дольше пятнадцати секунд — человек за это время решит, что сломалось");
  }else{
    head("5. Разговор с агентом");
    line("  пропущен: он тратит ключ Yandex. Включить — добавить --dialogue");
  }

  // ---- итог
  const after=await cgroup();
  head("Итог");
  if(after){
    const grew=before?after.current-before.current:0;
    line(`  Память: ${mb(after.current)}${after.max?` из ${mb(after.max)}`:""}, за тест ${grew>=0?"+":""}${mb(grew)}`);
    if(after.peak)line(`  Пик за всё время жизни службы: ${mb(after.peak)}${after.max?` (предел ${mb(after.max)})`:""}`);
    const dh=(after.events.high||0)-(before?.events.high||0);
    const dm=(after.events.max||0)-(before?.events.max||0);
    const dk=(after.events.oom_kill||0)-(before?.events.oom_kill||0);
    if(dk)line(`  ПРЕДЕЛ ПАМЯТИ УБИЛ СЛУЖБУ ${dk} раз за этот тест — MemoryMax слишком мал`);
    else if(dm)line(`  Упирались в жёсткий предел ${dm} раз — запас почти исчерпан`);
    else if(dh)line(`  Службу тормозили ради сброса страниц ${dh} раз — MemoryHigh ниже рабочего набора,`);
    if(dh&&!dk)line(`  а это и выглядит как «работает, но не реагирует»`);
    if(!dh&&!dm&&!dk)line("  В пределы памяти ни разу не упёрлись — дело не в них");
  }
  if(unauthorized){
    line("  ВСЕ ЗАПРОСЫ ОТКЛОНЕНЫ АВТОРИЗАЦИЕЙ (401).");
    line("  Значит подпись Telegram не сходится: токен в .env и бот, через которого");
    line("  открывают приложение, — разные. Для человека это выглядит как «ничего");
    line("  не работает»: сервер жив и быстр, но не отвечает ни на один запрос по делу.");
    line("  Проверить: token=$(grep -m1 ^TELEGRAM_BOT_TOKEN= .env | cut -d= -f2-); curl -s \"https://api.telegram.org/bot$token/getMe\"");
    line("  В ответе должно быть \"ok\":true и username того бота, через которого открываете.");
  }
  const worst=rows[rows.length-1];
  if(worst&&worst.bad)line(`  Под пиком ${worst.bad} запросов из ${worst.n} остались без ответа`);
  if(blocked)line("  Главное подозрение: синхронная работа в пути запроса, она останавливает всё приложение");
  line();
})().catch(e=>{console.error("стресс-тест не доехал:",e&&e.stack||e);process.exit(1)});
