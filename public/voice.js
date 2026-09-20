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
  ctx:null,stream:null,node:null,source:null,analyser:null,
  chunks:[],startedAt:0,quietSince:0,raf:0,level:0,smooth:0,
  audio:null,playAnalyser:null,conversation:null,api:null,busy:false
};

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
  try{state.ctx&&state.ctx.close()}catch(_){}
  const rate=state.ctx?state.ctx.sampleRate:48000;
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
  if(el)el.textContent=hint!==undefined?hint:(labels[p]||"");
}
function markContent(){
  const root=$("#voiceScreen");
  if(root)root.classList.add("hasContent");
}
function addLine(who,text){
  const box=$("#voiceLog");if(!box||!text)return null;
  markContent();
  const el=document.createElement("div");
  // Те же классы, что в переписке: одно место не должно выглядеть по-разному
  // в зависимости от того, спросили о нём голосом или написали.
  el.className="msg "+(who==="user"?"user":"ai");
  el.textContent=text;
  box.appendChild(el);
  box.scrollTop=box.scrollHeight;
  return el;
}
function clearLog(){
  const b=$("#voiceLog");if(b)b.innerHTML="";
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
  if(!chunks.length){setPhase("idle");return}
  const pcm=toPcm16(chunks,rate);
  if(pcm.length<TARGET_RATE*0.25){setPhase("idle","Слишком коротко — попробуйте ещё раз");return}
  try{
    const r=await state.api.apiFetch(`/api/voice/stt?rate=${TARGET_RATE}`,{
      method:"POST",headers:{"Content-Type":"application/octet-stream"},body:pcm.buffer});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.message||"Не удалось распознать");
    const text=String(d.text||"").trim();
    if(!text){setPhase("idle","Не расслышал. Скажите ещё раз");return}
    addLine("user",text);
    await ask(text);
  }catch(e){
    setPhase("error",String(e.message||e));
    addLine("agent","Не получилось: "+(e.message||e));
    setTimeout(()=>{if(state.phase==="error")setPhase("idle")},2600);
  }
}

async function ask(text){
  setPhase("thinking");
  let said="";
  const line=addLine("agent","…");
  try{
    const r=await state.api.apiFetch("/api/dialogue",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({message:text,voice:true,
        previous_response_id:state.conversation,context:state.api.context?state.api.context():{}})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.message||"Консьерж недоступен");
    state.conversation=d.response_id||state.conversation;
    said=String(d.reply||"").trim();
    if(line)line.textContent=said||"…";
    if(d.results&&d.results.length&&state.api.renderCards)state.api.renderCards(d.results,$("#voiceCards"));
    if(d.plan&&state.api.renderPlan)state.api.renderPlan(d.plan,$("#voiceCards"));
    await speak(said);
  }catch(e){
    if(line)line.textContent="Не получилось: "+(e.message||e);
    setPhase("error");
    setTimeout(()=>{if(state.phase==="error")setPhase("idle")},2600);
  }
}

async function speak(text){
  if(!text){setPhase("idle");return}
  try{
    const r=await state.api.apiFetch("/api/voice/tts",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});
    if(!r.ok)throw new Error("нет синтеза");
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const audio=new Audio(url);
    audio.playsInline=true;
    state.audio=audio;
    // Анализатор на воспроизведении: тот же шар должен дышать под голос агента.
    try{
      const Ctx=window.AudioContext||window.webkitAudioContext;
      const ctx=new Ctx();
      const src=ctx.createMediaElementSource(audio);
      const an=ctx.createAnalyser();an.fftSize=1024;
      src.connect(an);an.connect(ctx.destination);
      state.playAnalyser=an;
      audio.addEventListener("ended",()=>{try{ctx.close()}catch(_){}},{once:true});
    }catch(_){state.playAnalyser=null}
    setPhase("speaking","");
    await new Promise((resolve)=>{
      audio.addEventListener("ended",resolve,{once:true});
      audio.addEventListener("error",resolve,{once:true});
      audio.play().catch(resolve);
    });
    URL.revokeObjectURL(url);
  }catch(_){/* без голоса остаётся текст — это не повод обрывать разговор */}
  state.audio=null;state.playAnalyser=null;
  setPhase("idle");
}

function stopSpeaking(){
  if(state.audio){try{state.audio.pause()}catch(_){}state.audio=null}
  state.playAnalyser=null;
}

// ---- Управление ----

async function listen(){
  if(state.busy)return;
  state.busy=true;
  try{
    stopSpeaking();                       // перебить агента — нормальное поведение
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
  else if(state.phase==="speaking"){stopSpeaking();setPhase("idle")}
  else if(state.phase==="idle"||state.phase==="error")listen();
}

function open(){
  const root=$("#voiceScreen");if(!root)return;
  state.open=true;
  root.classList.add("on");
  root.classList.remove("hasContent");
  root.setAttribute("aria-hidden","false");
  document.body.style.overflow="hidden";
  setPhase("idle");
  if(!state.raf)state.raf=requestAnimationFrame(animate);
  listen();                                // окно открылось — сразу слушаем
}

function close(){
  state.open=false;
  stopSpeaking();
  if(state.phase==="listening")stopCapture();
  cancelAnimationFrame(state.raf);state.raf=0;
  const root=$("#voiceScreen");
  if(root){root.classList.remove("on");root.setAttribute("aria-hidden","true")}
  document.body.style.overflow="";
  setPhase("idle");
}

root.FreeVoice={
  init(api){state.api=api||{}},
  open,close,toggle,listen,
  get phase(){return state.phase},
  get isOpen(){return state.open},
  reset(){state.conversation=null;clearLog();const c=$("#voiceCards");if(c)c.innerHTML=""},
  // Открыто для тестов: разбор звука проверяется без микрофона.
  _audio:{downsample,toPcm16,rms}
};
})(typeof globalThis!=="undefined"?globalThis:this);
