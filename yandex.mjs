// Клиент Yandex Cloud: YandexGPT для диалога и SpeechKit для речи.
//
// Всё общение с сетью здесь проходит через внедряемый fetchImpl — иначе эту
// часть невозможно было бы проверить в среде без доступа наружу, а проверять
// её надо: у Яндекса ошибки приходят в трёх разных формах, и молча съеденная
// ошибка выглядит как «агент замолчал».
//
// Форматы звука выбраны так, чтобы обойтись без перекодирования на сервере:
//   запись  — LPCM 16 кГц моно, его SpeechKit принимает напрямую, и браузер
//             умеет его отдать через Web Audio (WebM/Opus от MediaRecorder
//             SpeechKit не принимает, а ffmpeg ради этого ставить незачем);
//   ответ   — MP3, потому что Ogg Opus в Safari до сих пор играет не везде.

const LLM_URL="https://llm.api.cloud.yandex.net/foundationModels/v1/completion";
const STT_URL="https://stt.api.cloud.yandex.net/speech/v1/stt:recognize";
const TTS_URL="https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize";

export const STT_MAX_BYTES=1024*1024;        // предел короткого распознавания
export const TTS_MAX_CHARS=5000;

export function yandexConfig(env=process.env){
  const key=env.YANDEX_API_KEY||"";
  const folder=env.YANDEX_FOLDER_ID||"";
  return {
    key,folder,
    ready:Boolean(key&&folder),
    model:env.YANDEX_MODEL||"yandexgpt/latest",
    voice:env.YANDEX_VOICE||"alena",
    emotion:env.YANDEX_EMOTION||"good",
    temperature:Number(env.YANDEX_TEMPERATURE||0.3),
    maxTokens:Number(env.YANDEX_MAX_TOKENS||1500)
  };
}

export function modelUri(cfg){
  // Полный URI можно задать целиком, иначе собираем из папки и имени модели.
  return /^gpt:\/\//.test(cfg.model)?cfg.model:`gpt://${cfg.folder}/${cfg.model}`;
}

export class YandexError extends Error{
  constructor(message,{status=0,code=null,retryable=false}={}){
    super(message);this.name="YandexError";this.status=status;this.code=code;this.retryable=retryable;
  }
}

// Ошибка приходит то как {error:{message}}, то как {message}, то просто текстом.
function describeError(status,body){
  let msg=null,code=null;
  if(body&&typeof body==="object"){
    const e=body.error&&typeof body.error==="object"?body.error:body;
    msg=e.message||e.error_message||null;
    code=e.code??e.error_code??null;
  }else if(typeof body==="string"&&body.trim()){
    msg=body.slice(0,300);
  }
  const retryable=status===429||status===500||status===502||status===503||status===504;
  const human=
    status===401||status===403?"Ключ Yandex Cloud не принят: проверьте YANDEX_API_KEY и права сервисного аккаунта":
    status===404?"Модель или каталог не найдены: проверьте YANDEX_FOLDER_ID и YANDEX_MODEL":
    status===429?"Превышен лимит запросов Yandex Cloud":
    msg||`Yandex Cloud ответил ${status}`;
  return new YandexError(human,{status,code,retryable});
}

async function call(url,{method="POST",headers={},body,cfg,timeoutMs=20000,fetchImpl=fetch,raw=false,signal=null}){
  if(!cfg.ready)throw new YandexError("Yandex Cloud не настроен: нужны YANDEX_API_KEY и YANDEX_FOLDER_ID",{status:0});
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  const onAbort=()=>ctrl.abort();
  if(signal)signal.addEventListener("abort",onAbort,{once:true});
  try{
    const r=await fetchImpl(url,{method,body,signal:ctrl.signal,
      headers:{"Authorization":`Api-Key ${cfg.key}`,...headers}});
    if(!r.ok){
      let parsed=null;
      try{parsed=await r.json()}catch{try{parsed=await r.text()}catch{parsed=null}}
      throw describeError(r.status,parsed);
    }
    return raw?Buffer.from(await r.arrayBuffer()):await r.json();
  }catch(e){
    if(e instanceof YandexError)throw e;
    if(e&&e.name==="AbortError")throw new YandexError("Yandex Cloud не ответил вовремя",{status:0,retryable:true});
    throw new YandexError(`Не удалось обратиться к Yandex Cloud: ${e&&e.message||e}`,{status:0,retryable:true});
  }finally{clearTimeout(timer);if(signal)signal.removeEventListener("abort",onAbort)}
}

/**
 * Один ход YandexGPT.
 * messages — [{role:"system"|"user"|"assistant", text}].
 * Возвращает {text, usage, model}.
 */
export async function yandexComplete(messages,{cfg=yandexConfig(),fetchImpl=fetch,timeoutMs=20000,signal=null,temperature,maxTokens}={}){
  const body=JSON.stringify({
    modelUri:modelUri(cfg),
    completionOptions:{
      stream:false,
      temperature:Number.isFinite(temperature)?temperature:cfg.temperature,
      maxTokens:String(maxTokens||cfg.maxTokens)
    },
    messages:messages.map(m=>({role:m.role,text:String(m.text??"")}))
  });
  const d=await call(LLM_URL,{body,cfg,fetchImpl,timeoutMs,signal,
    headers:{"Content-Type":"application/json","x-folder-id":cfg.folder}});
  const alt=d&&d.result&&Array.isArray(d.result.alternatives)?d.result.alternatives[0]:null;
  const text=alt&&alt.message?String(alt.message.text||""):"";
  // Пустой ответ — это отказ или срез по лимиту, а не «модель промолчала».
  if(!text.trim()){
    const status=alt&&alt.status||"нет альтернатив";
    throw new YandexError(`YandexGPT вернул пустой ответ (${status})`,{status:0,retryable:true});
  }
  return {text,usage:d.result.usage||null,model:d.result.modelVersion||cfg.model,status:alt.status||null};
}

/**
 * Распознавание короткой реплики. audio — Buffer с LPCM 16 бит моно.
 * SpeechKit принимает не больше мегабайта и тридцати секунд за раз.
 */
export async function yandexStt(audio,{cfg=yandexConfig(),fetchImpl=fetch,lang="ru-RU",
  sampleRateHertz=16000,format="lpcm",timeoutMs=15000,signal=null}={}){
  const buf=Buffer.isBuffer(audio)?audio:Buffer.from(audio||[]);
  if(!buf.length)throw new YandexError("Пустая запись",{status:0});
  if(buf.length>STT_MAX_BYTES)throw new YandexError("Запись длиннее тридцати секунд — распознаю по частям",{status:0});
  const u=new URL(STT_URL);
  u.searchParams.set("lang",lang);
  u.searchParams.set("folderId",cfg.folder);
  u.searchParams.set("format",format);
  if(format==="lpcm")u.searchParams.set("sampleRateHertz",String(sampleRateHertz));
  const d=await call(u.href,{body:buf,cfg,fetchImpl,timeoutMs,signal,
    headers:{"Content-Type":"application/octet-stream"}});
  return String(d&&d.result||"").trim();
}

/** Синтез речи. Возвращает Buffer с MP3. */
export async function yandexTts(text,{cfg=yandexConfig(),fetchImpl=fetch,lang="ru-RU",
  voice,emotion,speed=1.0,format="mp3",timeoutMs=15000,signal=null}={}){
  const t=String(text||"").trim();
  if(!t)throw new YandexError("Нечего произносить",{status:0});
  const form=new URLSearchParams({
    text:t.slice(0,TTS_MAX_CHARS),lang,
    voice:voice||cfg.voice,
    speed:String(speed),
    format,
    folderId:cfg.folder
  });
  // Эмоции поддерживает не каждый голос; для неподдерживающих параметр игнорируется.
  const emo=emotion||cfg.emotion;
  if(emo)form.set("emotion",emo);
  return call(TTS_URL,{body:form.toString(),cfg,fetchImpl,timeoutMs,signal,raw:true,
    headers:{"Content-Type":"application/x-www-form-urlencoded"}});
}

/** Быстрая проверка настроек: что именно не так, видно до первого разговора. */
export function yandexStatus(env=process.env){
  const cfg=yandexConfig(env);
  return {
    ready:cfg.ready,
    has_key:Boolean(cfg.key),
    has_folder:Boolean(cfg.folder),
    model:cfg.ready?modelUri(cfg):null,
    voice:cfg.voice
  };
}
