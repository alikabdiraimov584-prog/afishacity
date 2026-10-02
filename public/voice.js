// Полноэкранный разговор с консьержем.
//
// Устройство записи выбрано не по моде, а по тому, что реально работает в
// вебвью Telegram на iPhone:
//   • MediaRecorder отдаёт WebM/Opus в Chrome и MP4/AAC в Safari — SpeechKit не
//     принимает ни то, ни другое, а ставить ffmpeg на сервер ради перекодирования
//     несоразмерно. Поэтому пишем сырой PCM через Web Audio и сами сводим его
//     к 16 кГц моно — этот формат SpeechKit берёт напрямую.
//   • ScriptProcessorNode устарел, но AudioWorklet в вебвью Telegram на части
//     устройств не поднимается. Берём Worklet, когда он есть, иначе откатываемся.
//   • AudioContext на iOS запускается только внутри жеста пользователя, поэтому
//     он создаётся в обработчике нажатия, а не заранее.
(function(root){
"use strict";

const TARGET_RATE=16000;
const SILENCE_MS=1400;          // столько тишины — и считаем, что человек договорил
const MAX_MS=25000;             // предел короткого распознавания SpeechKit
const MIN_MS=350;               // случайное касание записью не считаем

const state={
  open:false,phase:"idle",      // idle | listening | thinking | speaking | error
  ctx:null,stream:null,node:null,source:null,analyser:null,playCtx:null,
  chunks:[],startedAt:0,quietSince:0,raf:0,level:0,smooth:0,
  audio:null,playAnalyser:null,conversation:null,api:null,busy:false,
  // Разговор без рук: после ответа микрофон включается сам. Выключается по
  // кнопке, по закрытию экрана или после двух подряд неудачных распознаваний —
  // иначе в шумном месте экран будет бесконечно слушать пустоту.
  hands:true,silentRuns:0,resumeTimer:0,
  // Идёт ход: человек договорил, ответа ещё нет. Короткий отклик («секунду»)
  // звучит внутри хода, и после него экран должен вернуться в «думаю», а не
  // в ожидание — иначе разговор без рук начал бы слушать посреди ответа.
  inTurn:false
};
const RESUME_MS=420;          // пауза перед новым слушанием: хвост ответа не должен попасть в запись
const SILENT_LIMIT=2;

// ---- Звук ----

function downsample(buffer,fromRate,toRate){
  if(toRate>=fromRate)return Float32Array.from(buffer);
  const ratio=fromRate/toRate,out=new Float32Array(Math.floor(buffer.length/ratio));
  for(let i=0;i<out.length;i++){
    // Усредняем окно, а не берём каждый n-й отсчёт: прореживание даёт алиасинг,
    // и распознавание начинает ошибаться на шипящих.
    const start=Math.floor(i*ratio),end=Math.min(buffer.length,Math.floor((i+1)*ratio));
    let sum=0;for(let j=start;j<end;j++)sum+=buffer[j];
    out[i]=end>start?sum/(end-start):0;
  }
  return out;
}
function toPcm16(chunks,fromRate){
  let total=0;for(const c of chunks)total+=c.length;
  const merged=new Float32Array(total);
  let at=0;for(const c of chunks){merged.set(c,at);at+=c.length}
  const low=downsample(merged,fromRate,TARGET_RATE);
  const pcm=new Int16Array(low.length);
  for(let i=0;i<low.length;i++){
    const v=Math.max(-1,Math.min(1,low[i]));
    pcm[i]=v<0?v*0x8000:v*0x7fff;
  }
  return pcm;
}
function rms(buf){
  let sum=0;for(let i=0;i<buf.length;i++)sum+=buf[i]*buf[i];
  return Math.sqrt(sum/buf.length);
}

const WORKLET=`
class Cap extends AudioWorkletProcessor{
  process(inputs){
    const ch=inputs[0]&&inputs[0][0];
    if(ch&&ch.length)this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor("free-cap",Cap);`;

async function startCapture(){
  const stream=await navigator.mediaDevices.getUserMedia({audio:{
    channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  const Ctx=window.AudioContext||window.webkitAudioContext;
  const ctx=new Ctx();
  if(ctx.state==="suspended")await ctx.resume();
  const source=ctx.createMediaStreamSource(stream);
  const analyser=ctx.createAnalyser();analyser.fftSize=1024;source.connect(analyser);

  let node=null;
  const onSamples=(data)=>{
    if(state.phase!=="listening")return;
    state.chunks.push(data);
    const level=rms(data);
    state.level=level;
    const now=performance.now();
    if(level>0.012)state.quietSince=0;
    else if(!state.quietSince)state.quietSince=now;
    if(state.quietSince&&now-state.quietSince>SILENCE_MS&&now-state.startedAt>MIN_MS)stopAndSend();
    else if(now-state.startedAt>MAX_MS)stopAndSend();
  };

  if(ctx.audioWorklet){
    try{
      const url=URL.createObjectURL(new Blob([WORKLET],{type:"text/javascript"}));
      await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
      node=new AudioWorkletNode(ctx,"free-cap");
      node.port.onmessage=(e)=>onSamples(e.data);
    }catch(_){node=null}
  }
  if(!node){
    node=ctx.createScriptProcessor(4096,1,1);
    node.onaudioprocess=(e)=>onSamples(Float32Array.from(e.inputBuffer.getChannelData(0)));
  }
  source.connect(node);
  // ScriptProcessor не вызывает обработчик, пока не подключён к выходу.
  // Гасим звук нулевым усилением, чтобы не возникло обратной связи.
  const mute=ctx.createGain();mute.gain.value=0;node.connect(mute);mute.connect(ctx.destination);

  Object.assign(state,{ctx,stream,node,source,analyser,chunks:[],
    startedAt:performance.now(),quietSince:0});
}

function stopCapture(){
  try{state.node&&state.node.disconnect()}catch(_){}
  try{state.source&&state.source.disconnect()}catch(_){}
  try{state.stream&&state.stream.getTracks().forEach(t=>t.stop())}catch(_){}
  // Частоту берём до закрытия: у закрытого контекста читать её незачем, а
  // ошибка здесь тихо сдвинет высоту звука и испортит распознавание.
  const rate=state.ctx?state.ctx.sampleRate:48000;
  try{state.ctx&&state.ctx.close()}catch(_){}
  const chunks=state.chunks;
  Object.assign(state,{ctx:null,stream:null,node:null,source:null,analyser:null,chunks:[]});
  return {chunks,rate};
}

// ---- Отрисовка ----

const $=(s)=>document.querySelector(s);
// Строки экрана: переводчик приходит из страницы (init({t})); без него —
// русские тексты, как и было.
const RU={"voice.idle":"Нажмите и говорите","voice.listening":"Слушаю…","voice.thinking":"Думаю…","voice.tooShort":"Слишком коротко — попробуйте ещё раз",
  "voice.sttFail":"Не удалось распознать","voice.notHeard":"Не расслышал. Скажите ещё раз","voice.failed":"Не получилось: ","voice.agentDown":"Консьерж недоступен",
  "voice.searching":"Ищу","voice.ready":"Нажмите, когда будете готовы","voice.noTts":"нет синтеза","voice.micNeeded":"Нужен доступ к микрофону","voice.micDown":"Микрофон недоступен: ",
  "voice.hands.title.on":"Разговор идёт сам — нажмите, чтобы отвечать по кнопке","voice.hands.title.off":"Включить разговор без рук","voice.quoteL":"«","voice.quoteR":"»",
  "voice.fallbackFound":"Вот что нашёл.","voice.retryLater":"Сейчас не могу ответить — попробуйте ещё раз через минуту."};
const RU_ACK=["Секунду, смотрю…","Сейчас посмотрю…","Так, ищу…"];
function T(key){const f=state.api&&state.api.t;const v=typeof f==="function"?f(key):undefined;return typeof v==="string"&&v!==key?v:(RU[key]||key)}
// Один разговор с перепиской: идентификатор берём у страницы и отдаём ей.
// Раньше у голоса была своя нить, и, переключившись, человек начинал заново.
function conv(){const g=state.api&&state.api.getConversation;return typeof g==="function"?(g()||null):state.conversation}
function setConv(id){if(!id)return;state.conversation=id;const s=state.api&&state.api.setConversation;if(typeof s==="function")s(id)}
function setPhase(p,hint){
  state.phase=p;
  const root=$("#voiceScreen");
  if(!root)return;
  root.dataset.phase=p;
  const labels={idle:T("voice.idle"),listening:T("voice.listening"),thinking:T("voice.thinking"),speaking:"",error:""};
  const el=$("#voiceHint");
  // «Нажмите и говорите» — подсказка для первого раза. Над состоявшимся
  // разговором она уже ничего не объясняет и только добавляет третью строку
  // текста к двум осмысленным.
  const idleWithContent=p==="idle"&&root.classList.contains("hasContent");
  if(el)el.textContent=hint!==undefined?hint:(idleWithContent?"":(labels[p]||""));
}
function markContent(){
  const root=$("#voiceScreen");
  if(root)root.classList.add("hasContent");
}
// На экране живёт только текущий обмен. Накопленный журнал здесь не нужен:
// всё сказанное человек уже слышал, а прочитать историю можно в переписке.
function showHeard(text){
  const el=$("#voiceHeard");if(!el)return;
  el.textContent=text?T("voice.quoteL")+text+T("voice.quoteR"):"";
  if(text)markContent();
}
function showSaid(text){
  const el=$("#voiceSaid");if(!el)return;
  el.textContent=text||"";
  if(text)markContent();
}
function clearLog(){
  showHeard("");showSaid("");
  const root=$("#voiceScreen");if(root)root.classList.remove("hasContent");
}

// Шар в центре: размер ведёт громкость, вращение идёт всегда.
function animate(){
  const orb=$("#voiceOrb");
  if(!orb||!state.open){state.raf=0;return}
  let level=0;
  const an=state.phase==="speaking"?state.playAnalyser:state.analyser;
  if(an){
    const data=new Uint8Array(an.frequencyBinCount);
    an.getByteTimeDomainData(data);
    let sum=0;for(let i=0;i<data.length;i++){const v=(data[i]-128)/128;sum+=v*v}
    level=Math.sqrt(sum/data.length);
  }
  // Сглаживаем: шар должен дышать, а не дёргаться на каждом кадре.
  state.smooth+=(level-state.smooth)*0.18;
  const scale=1+Math.min(0.42,state.smooth*2.6);
  orb.style.setProperty("--orb-scale",scale.toFixed(3));
  orb.style.setProperty("--orb-glow",Math.min(1,state.smooth*3.4).toFixed(3));
  state.raf=requestAnimationFrame(animate);
}

// ---- Разговор ----

async function stopAndSend(){
  if(state.phase!=="listening")return;
  setPhase("thinking");
  const {chunks,rate}=stopCapture();
  if(!chunks.length){setPhase("idle");state.silentRuns++;maybeResume();return}
  const pcm=toPcm16(chunks,rate);
  if(pcm.length<TARGET_RATE*0.25){setPhase("idle",T("voice.tooShort"));state.silentRuns++;maybeResume();return}
  // Человек договорил — сразу короткий отклик, пока идут распознавание и поиск:
  // несколько секунд тишины в разговоре вслух звучат как «сломалось».
  state.inTurn=true;
  playAck();
  try{
    const r=await state.api.apiFetch(`/api/voice/stt?rate=${TARGET_RATE}`,{
      method:"POST",headers:{"Content-Type":"application/octet-stream"},body:pcm.buffer});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.message||T("voice.sttFail"));
    const text=String(d.text||"").trim();
    if(!text){state.inTurn=false;resetSpeech();setPhase("idle",T("voice.notHeard"));state.silentRuns++;maybeResume();return}
    state.silentRuns=0;                  // услышали — счётчик пустых попыток обнуляем
    showHeard(text);showSaid("");
    await ask(text,{keepAck:true});
  }catch(e){
    state.inTurn=false;resetSpeech();
    setPhase("error",String(e.message||e));
    showSaid(T("voice.failed")+(e.message||e));
    // После ошибки сам не продолжаем: непрерывный разговор превратился бы
    // в цикл из одной и той же ошибки.
    state.hands=false;updateHandsButton();
    setTimeout(()=>{if(state.phase==="error")setPhase("idle")},2600);
  }
}

/**
 * Один ход разговора.
 *
 * Идём потоковым каналом, а не обычным запросом. Разница не в красоте: за
 * один ход агент успевает сходить к модели, поискать места и сходить к модели
 * ещё раз. Ожидание всего ответа целиком — это несколько секунд полной тишины,
 * а в разговоре вслух тишина читается как «сломалось». Здесь же первая фраза
 * произносится, пока поиск ещё идёт.
 */
/* Сбой консьержа — не тупик.
 * Поток оборвался до ответа — один повтор обычным запросом. Не вышло и он —
 * ищем места по сказанной фразе напрямую (/api/recommend) и показываем
 * карточки. Совсем ничего — короткое человеческое «попробуйте через минуту»,
 * а не текст исключения. Если часть ответа уже прозвучала, повторять её не
 * надо: ход заканчиваем тем, что успели сказать. */
async function ask(text,opts={}){
  setPhase("thinking");
  if(!opts.keepAck)resetSpeech();        // отклик «секунду» уже в очереди — его не сбрасываем
  state.inTurn=true;
  try{
    try{await askStream(text)}
    catch(e){
      if(e&&e.status&&e.status<500&&e.status!==408&&e.status!==429)throw e;
      try{await askPlain(text)}
      catch(e2){if(!(await searchInstead(text)))throw e2}
    }
    await speechIdle();
    settle();
  }catch(e){
    console.warn("voice:",e&&e.message);
    state.inTurn=false;
    resetSpeech();
    showSaid(T("voice.retryLater"));
    setPhase("error");
    state.hands=false;updateHandsButton();
    setTimeout(()=>{if(state.phase==="error")setPhase("idle")},2600);
  }
}

function dialogueBody(text){
  return JSON.stringify({message:text,voice:true,previous_response_id:conv(),context:state.api.context?state.api.context():{}});
}
async function askStream(text){
  const r=await state.api.apiFetch("/api/dialogue/stream",{
    method:"POST",headers:{"Content-Type":"application/json"},body:dialogueBody(text)});
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    const e=new Error(d.message||T("voice.agentDown"));e.status=r.status;throw e;
  }
  if(!r.body||!r.body.getReader)return askPlain(text);   // старый браузер без потоков
  let failed=null,spoke=false;
  try{
    await readEvents(r.body,(type,data)=>{
      if(type==="delta"&&data.text){
        // Промежуточную реплику показываем, но не произносим: следом придёт
        // ответ по существу, и озвучивать обе — это два голоса подряд об
        // одном и том же.
        showSaid(data.text);
        if(!data.interim){enqueueSpeech(data.text);spoke=true}
        else setPhase("thinking",T("voice.searching"));
      }else if(type==="status"&&data&&data.text){
        if(state.phase==="thinking")setPhase("thinking",data.text+"…");
      }else if(type==="done"){
        setConv(data.response_id);
        renderOut(data);
      }else if(type==="error"){
        failed=new Error(data.message||T("voice.agentDown"));
      }
    });
  }catch(e){failed=e}
  if(failed&&!spoke)throw failed;
}

// Обычный запрос: если потоки недоступны или поток оборвался.
async function askPlain(text){
  const r=await state.api.apiFetch("/api/dialogue",{
    method:"POST",headers:{"Content-Type":"application/json"},body:dialogueBody(text)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(d.message||T("voice.agentDown"));e.status=r.status;throw e}
  setConv(d.response_id);
  const said=String(d.reply||"").trim();
  showSaid(said);
  renderOut(d);
  enqueueSpeech(said);
}

// Последний запасной путь: прямой поиск по сказанной фразе, без консьержа.
async function searchInstead(text){
  try{
    const ctx=state.api.context?state.api.context():{};
    const body={query:text,taste_weights:ctx.taste_weights||{}};
    if(ctx.user_location)body.user_location=ctx.user_location;
    const r=await state.api.apiFetch("/api/recommend",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if(!r.ok)return false;
    const d=await r.json().catch(()=>({}));
    const rs=Array.isArray(d.results)?d.results.slice(0,3):[];
    if(!rs.length)return false;
    const said=T("voice.fallbackFound");
    showSaid(said);
    renderOut({results:rs});
    enqueueSpeech(said);
    return true;
  }catch(_){return false}
}

/**
 * Конец хода.
 *
 * Обычно экран выводит из «думаю» очередь речи: договорила — вернулись в
 * ожидание и снова слушаем. Но если произносить было нечего, очередь не
 * запускалась вовсе, и экран оставался в «Ищу» навсегда: шар не реагировал,
 * разговор без рук не продолжался, и выглядело это как «она не отвечает».
 * Сервер за это не отвечает — ход закончен, и состояние должно сойтись
 * независимо от того, что он прислал.
 */
function settle(){
  state.inTurn=false;
  if(state.phase==="thinking"||state.phase==="speaking")setPhase("idle");
  maybeResume();
}

function renderOut(d){
  if(!d)return;
  if(d.results&&d.results.length&&state.api.renderCards)state.api.renderCards(d.results,$("#voiceCards"));
  if(d.plan&&state.api.renderPlan)state.api.renderPlan(d.plan,$("#voiceCards"));
}

/** Разбор потока server-sent events. Строки-комментарии (пинги) пропускаем. */
async function readEvents(body,onEvent){
  const reader=body.getReader(),dec=new TextDecoder();
  let buf="";
  for(;;){
    const {value,done}=await reader.read();
    if(done)break;
    buf+=dec.decode(value,{stream:true});
    let i;
    while((i=buf.indexOf("\n\n"))>=0){
      const raw=buf.slice(0,i);buf=buf.slice(i+2);
      let type="message",data="";
      for(const line of raw.split("\n")){
        if(line.startsWith("event:"))type=line.slice(6).trim();
        else if(line.startsWith("data:"))data+=line.slice(5).trim();
      }
      if(!data)continue;
      let parsed=null;
      try{parsed=JSON.parse(data)}catch(_){continue}
      onEvent(type,parsed);
    }
  }
}

/* Очередь речи.
 *
 * Реплики приходят по одной, и синтез каждой — отдельный поход в сеть. Если
 * ждать его в момент, когда предыдущая фраза договорена, между фразами
 * появляется дыра. Поэтому синтез запускается сразу при постановке в очередь
 * и идёт, пока звучит предыдущая; проигрывание при этом строго по порядку. */
const speech={queue:[],draining:false,token:0,stopCurrent:null};

function resetSpeech(){
  speech.token++;                      // всё, что было заказано, больше не наше
  // Отменённые реплики всё равно надо дочитать: синтез уже заказан, и если
  // промис никто не тронет, браузер сообщит о необработанном отказе.
  for(const item of speech.queue)if(item&&item.audio)item.audio.catch(()=>{});
  speech.queue.length=0;
  stopSpeaking();
}

// Первое предложение длинной реплики синтезируем отдельно: короткий кусок
// готов быстрее, и голос начинается раньше, пока досинтезируется остальное.
function speechParts(text){
  if(text.length<90)return [text];
  const m=text.match(/^([\s\S]{12,160}?[.!?…])\s+([\s\S]+)$/);
  return m?[m[1],m[2]]:[text];
}
function enqueueSpeech(text){
  const t=String(text||"").trim();
  if(!t)return;
  const mine=speech.token;
  for(const part of speechParts(t)){
    const audio=ttsBlob(part);
    audio.catch(()=>{});               // отказ разберём в очереди, здесь только гасим
    speech.queue.push({mine,audio});
  }
  if(!speech.draining)drainSpeech();
}

/* Короткий отклик «секунду, смотрю…».
 * Синтезируется один раз, при открытии экрана, и хранится готовым звуком:
 * звучать он должен сразу, а не после ещё одного похода в сеть. Нет синтеза —
 * нет и отклика, разговор идёт как раньше. */
const ack={blobs:[],loading:false,next:0,failedAt:0};
function ackPhrases(){
  const f=state.api&&state.api.t;
  const v=typeof f==="function"?f("voice.ack"):null;
  return Array.isArray(v)&&v.length?v:RU_ACK;
}
function warmAck(){
  if(ack.loading||ack.blobs.length||!state.api||!state.api.apiFetch)return;
  if(ack.failedAt&&Date.now()-ack.failedAt<60000)return;
  ack.loading=true;
  (async()=>{
    for(const p of ackPhrases().slice(0,3)){
      try{const b=await ttsBlob(p);if(b)ack.blobs.push(b)}catch(_){ack.failedAt=Date.now();break}
    }
    ack.loading=false;
  })();
}
function playAck(){
  if(!ack.blobs.length)return;
  const blob=ack.blobs[ack.next++%ack.blobs.length];
  speech.queue.push({mine:speech.token,audio:Promise.resolve(blob)});
  if(!speech.draining)drainSpeech();
}

async function ttsBlob(text){
  const r=await state.api.apiFetch("/api/voice/tts",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});
  if(!r.ok)throw new Error(T("voice.noTts"));
  return r.blob();
}

async function drainSpeech(){
  speech.draining=true;
  try{
    while(speech.queue.length){
      const item=speech.queue.shift();
      if(item.mine!==speech.token)continue;         // разговор уже ушёл дальше
      let blob=null;
      // Молчание вместо реплики — это не повод обрывать разговор: текст на
      // экране остаётся, и следующая фраза всё равно прозвучит.
      try{blob=await item.audio}catch(_){continue}
      if(item.mine!==speech.token)continue;
      await playBlob(blob);
    }
  }finally{
    speech.draining=false;
    // Внутри хода (прозвучал только отклик) — обратно в «думаю», слушать рано.
    if(state.phase==="speaking")setPhase(state.inTurn?"thinking":"idle");
    if(!state.inTurn)maybeResume();
  }
}

/** Продолжаем слушать сами, если разговор идёт без рук. */
function maybeResume(){
  clearTimeout(state.resumeTimer);
  if(!state.hands||!state.open)return;
  if(state.phase!=="idle")return;
  if(state.silentRuns>=SILENT_LIMIT){
    setPhase("idle",T("voice.ready"));
    return;
  }
  // Небольшая пауза: без неё в запись попадает хвост собственного ответа,
  // и агент отвечает сам себе.
  state.resumeTimer=setTimeout(()=>{
    if(state.hands&&state.open&&state.phase==="idle")listen();
  },RESUME_MS);
}

/** Ждём, пока очередь опустеет: ход закончен, когда всё произнесено. */
async function speechIdle(){
  while(speech.draining||speech.queue.length)await new Promise(r=>setTimeout(r,60));
}

/* Один звуковой контекст на весь разговор.
 *
 * Раньше он создавался на каждую фразу. Браузеры разрешают держать всего
 * несколько штук одновременно, и после пары ходов создание начинало падать:
 * шар переставал дышать под голос, а контексты копились незакрытыми. */
function audioCtx(){
  // Отдельный контекст от записи: stopCapture() закрывает свой после каждой
  // фразы, и общий на двоих закрывался бы прямо перед ответом агента.
  if(state.playCtx&&state.playCtx.state!=="closed")return state.playCtx;
  const Ctx=window.AudioContext||window.webkitAudioContext;
  if(!Ctx)return null;
  try{state.playCtx=new Ctx()}catch(_){state.playCtx=null}
  return state.playCtx;
}

function playBlob(blob){
  const url=URL.createObjectURL(blob);
  const audio=new Audio(url);
  audio.playsInline=true;
  state.audio=audio;
  let node=null;
  // Анализатор на воспроизведении: тот же шар должен дышать под голос агента.
  try{
    const ctx=audioCtx();
    if(ctx){
      if(ctx.state==="suspended")ctx.resume().catch(()=>{});
      node=ctx.createMediaElementSource(audio);
      const an=ctx.createAnalyser();an.fftSize=1024;
      node.connect(an);an.connect(ctx.destination);
      state.playAnalyser=an;
    }
  }catch(_){state.playAnalyser=null}
  setPhase("speaking","");
  return new Promise((resolve)=>{
    let done=false;
    const end=()=>{
      if(done)return;                  // ended и error могут прийти оба
      done=true;
      speech.stopCurrent=null;
      try{audio.pause()}catch(_){}
      try{if(node)node.disconnect()}catch(_){}
      URL.revokeObjectURL(url);
      if(state.audio===audio)state.audio=null;
      state.playAnalyser=null;
      resolve();
    };
    // Перебить агента должно заканчивать реплику, а не подвешивать очередь:
    // pause() не вызывает ended, и цикл воспроизведения ждал бы его вечно —
    // после первого же перебивания агент замолкал до перезагрузки страницы.
    speech.stopCurrent=end;
    audio.addEventListener("ended",end,{once:true});
    audio.addEventListener("error",end,{once:true});
    audio.play().catch(end);
  });
}

function stopSpeaking(){
  const end=speech.stopCurrent;speech.stopCurrent=null;
  if(end)end();                        // освобождаем ожидание в playBlob
  if(state.audio){try{state.audio.pause()}catch(_){}state.audio=null}
  state.playAnalyser=null;
}

// ---- Управление ----

async function listen(){
  if(state.busy)return;
  state.busy=true;
  try{
    resetSpeech();                        // перебить агента — нормальное поведение
    setPhase("listening");
    await startCapture();
  }catch(e){
    setPhase("error",e&&e.name==="NotAllowedError"
      ?T("voice.micNeeded")
      :T("voice.micDown")+(e.message||e));
    setTimeout(()=>{if(state.phase==="error")setPhase("idle")},3000);
  }finally{state.busy=false}
}

function toggle(){
  if(state.phase==="listening")stopAndSend();
  else if(state.phase==="speaking"){resetSpeech();setPhase("idle")}
  else if(state.phase==="idle"||state.phase==="error"){state.silentRuns=0;listen()}
}

/** Включить или выключить разговор без рук. */
function setHands(on){
  state.hands=Boolean(on);
  state.silentRuns=0;
  clearTimeout(state.resumeTimer);
  updateHandsButton();
  if(state.hands&&state.open&&state.phase==="idle")maybeResume();
  else if(!state.hands&&state.phase==="listening")stopCapture(),setPhase("idle");
}
function updateHandsButton(){
  const b=$("#vHands");if(!b)return;
  b.classList.toggle("on",state.hands);
  b.setAttribute("aria-pressed",state.hands?"true":"false");
  b.title=state.hands?T("voice.hands.title.on"):T("voice.hands.title.off");
}

function open(){
  const root=$("#voiceScreen");if(!root)return;
  state.open=true;
  root.classList.add("on");
  root.classList.remove("hasContent");
  root.setAttribute("aria-hidden","false");
  document.body.style.overflow="hidden";
  setPhase("idle");
  state.silentRuns=0;
  updateHandsButton();
  if(!state.raf)state.raf=requestAnimationFrame(animate);
  warmAck();                               // отклик синтезируется, пока человек говорит первую фразу
  listen();                                // окно открылось — сразу слушаем
}

function close(){
  state.open=false;state.inTurn=false;
  clearTimeout(state.resumeTimer);state.resumeTimer=0;
  resetSpeech();
  // Звуковой контекст держит устройство вывода: закрытый экран не должен
  // оставлять его висеть.
  if(state.playCtx){const c=state.playCtx;state.playCtx=null;try{c.close()}catch(_){}}
  if(state.phase==="listening")stopCapture();
  cancelAnimationFrame(state.raf);state.raf=0;
  const root=$("#voiceScreen");
  if(root){root.classList.remove("on");root.setAttribute("aria-hidden","true")}
  document.body.style.overflow="";
  setPhase("idle");
}

root.FreeVoice={
  init(api){state.api=api||{}},
  open,close,toggle,listen,setHands,
  get hands(){return state.hands},
  get phase(){return state.phase},
  get isOpen(){return state.open},
  reset(){state.conversation=null;clearLog();const c=$("#voiceCards");if(c)c.innerHTML=""},
  // Открыто для тестов: разбор звука проверяется без микрофона, а состояние
  // очереди речи — без угадывания по таймингам.
  _audio:{downsample,toPcm16,rms},
  _speech:speech,
  // Ход разговора без микрофона: в песочнице он не отдаёт звука, и проверить
  // иначе, что промежуточная реплика не произносится, невозможно.
  _ask:(text)=>ask(text),
  get _silent(){return state.silentRuns}
};
})(typeof globalThis!=="undefined"?globalThis:this);
