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
  hands:true,silentRuns:0,resumeTimer:0
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
function setPhase(p,hint){
  state.phase=p;
  const root=$("#voiceScreen");
  if(!root)return;
  root.dataset.phase=p;
  const labels={idle:"Нажмите и говорите",listening:"Слушаю…",thinking:"Думаю…",speaking:"",error:""};
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
  el.textContent=text?"«"+text+"»":"";
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
  if(pcm.length<TARGET_RATE*0.25){setPhase("idle","Слишком коротко — попробуйте ещё раз");state.silentRuns++;maybeResume();return}
  try{
    const r=await state.api.apiFetch(`/api/voice/stt?rate=${TARGET_RATE}`,{
      method:"POST",headers:{"Content-Type":"application/octet-stream"},body:pcm.buffer});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.message||"Не удалось распознать");
    const text=String(d.text||"").trim();
    if(!text){setPhase("idle","Не расслышал. Скажите ещё раз");state.silentRuns++;maybeResume();return}
    state.silentRuns=0;                  // услышали — счётчик пустых попыток обнуляем
    showHeard(text);showSaid("");
    await ask(text);
  }catch(e){
    setPhase("error",String(e.message||e));
    showSaid("Не получилось: "+(e.message||e));
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
async function ask(text){
  setPhase("thinking");
  resetSpeech();
  try{
    const r=await state.api.apiFetch("/api/dialogue/stream",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:text,voice:true,
        previous_response_id:state.conversation,context:state.api.context?state.api.context():{}})});
    if(!r.ok){
      const d=await r.json().catch(()=>({}));
      throw new Error(d.message||"Консьерж недоступен");
    }
    if(!r.body||!r.body.getReader)return askPlain(text);   // старый браузер без потоков
    let failed=null;
    await readEvents(r.body,(type,data)=>{
      if(type==="delta"&&data.text){
        // Промежуточную реплику показываем, но не произносим: следом придёт
        // ответ по существу, и озвучивать обе — это два голоса подряд об
        // одном и том же.
        showSaid(data.text);
        if(!data.interim)enqueueSpeech(data.text);
        else setPhase("thinking","Ищу");
      }else if(type==="status"&&data&&data.text){
        if(state.phase==="thinking")setPhase("thinking",data.text+"…");
      }else if(type==="done"){
        state.conversation=data.response_id||state.conversation;
        renderOut(data);
      }else if(type==="error"){
        failed=new Error(data.message||"Консьерж недоступен");
      }
    });
    if(failed)throw failed;
    await speechIdle();
  }catch(e){
    resetSpeech();
    showSaid("Не получилось: "+(e.message||e));
    setPhase("error");
    state.hands=false;updateHandsButton();
    setTimeout(()=>{if(state.phase==="error")setPhase("idle")},2600);
  }
}

// Запасной путь: обычный запрос, если потоки недоступны.
async function askPlain(text){
  const r=await state.api.apiFetch("/api/dialogue",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({message:text,voice:true,
      previous_response_id:state.conversation,context:state.api.context?state.api.context():{}})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.message||"Консьерж недоступен");
  state.conversation=d.response_id||state.conversation;
  const said=String(d.reply||"").trim();
  showSaid(said);
  renderOut(d);
  enqueueSpeech(said);
  await speechIdle();
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

function enqueueSpeech(text){
  const t=String(text||"").trim();
  if(!t)return;
  const mine=speech.token;
  const audio=ttsBlob(t);
  audio.catch(()=>{});                 // отказ разберём в очереди, здесь только гасим
  speech.queue.push({mine,audio});
  if(!speech.draining)drainSpeech();
}

async function ttsBlob(text){
  const r=await state.api.apiFetch("/api/voice/tts",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});
  if(!r.ok)throw new Error("нет синтеза");
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
    if(state.phase==="speaking")setPhase("idle");
    maybeResume();
  }
}

/** Продолжаем слушать сами, если разговор идёт без рук. */
function maybeResume(){
  clearTimeout(state.resumeTimer);
  if(!state.hands||!state.open)return;
  if(state.phase!=="idle")return;
  if(state.silentRuns>=SILENT_LIMIT){
    setPhase("idle","Нажмите, когда будете готовы");
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
      ?"Нужен доступ к микрофону"
      :"Микрофон недоступен: "+(e.message||e));
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
  b.title=state.hands?"Разговор идёт сам — нажмите, чтобы отвечать по кнопке":"Включить разговор без рук";
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
  listen();                                // окно открылось — сразу слушаем
}

function close(){
  state.open=false;
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
