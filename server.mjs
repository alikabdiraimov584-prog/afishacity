import http from "node:http";
import {readFile} from "node:fs/promises";
import {extname,join,normalize} from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {verifyInitData,createRateLimiter} from "./telegram.mjs";
import {buildPlan,planSummary} from "./planner.mjs";
import {openStore} from "./store.mjs";
import {searchLiveInventory} from "./providers.mjs";
import {rankLive,resultPayload} from "./live_ranker.mjs";
import {startWarmup} from "./warmup.mjs";

const __dirname=fileURLToPath(new URL(".",import.meta.url));
const PUBLIC=join(__dirname,"public");
const PORT=Number(process.env.PORT||3000);
const HOST=process.env.HOST||"127.0.0.1";
// Токен бота включает проверку подписи Telegram Mini App для платных эндпоинтов.
const TG_BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||"";
const TG_REQUIRED=Boolean(TG_BOT_TOKEN);
const dialogueLimiter=createRateLimiter({limit:Number(process.env.DIALOGUE_RATE_LIMIT||40),windowMs:10*60*1000});
setInterval(()=>dialogueLimiter.sweep(),5*60*1000).unref();
function clientKey(req){
  const fwd=String(req.headers["x-forwarded-for"]||"").split(",")[0].trim();
  return fwd||req.socket?.remoteAddress||"unknown";
}
// Возвращает {user} либо {error} для ответа. Без токена бота (локальная разработка) пропускает всех.
function authorize(req){
  if(!TG_REQUIRED)return {user:null};
  const v=verifyInitData(req.headers["x-telegram-init-data"],TG_BOT_TOKEN);
  if(!v.ok)return {error:{status:401,error:"telegram_auth_required",reason:v.reason,message:"Откройте FREE через Telegram-бота"}};
  return {user:v.user};
}
// Хранилище: SQLite в data/free.db (FREE_DB переопределяет путь; в тестах — память).
const store=openStore(process.env.FREE_DB||(process.env.NODE_ENV==="test"?":memory:":join(__dirname,"data","free.db")));
// Кто перед нами: пользователь Telegram (после проверки подписи) и/или анонимный клиент из заголовка.
function identify(req,auth){
  const anon=String(req.headers["x-free-client"]||"").trim();
  const anon_id=/^[a-z0-9-]{8,64}$/i.test(anon)?anon:null;
  const tg=auth?.user||null;
  return store.user({tg_id:tg?.id||null,anon_id,first_name:tg?.first_name||null});
}
const CACHE=new Map();
const CACHE_MS=5*60*1000;

const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png"};

// CORS для мобильного приложения: WebView Capacitor живёт на capacitor://localhost (iOS) и http://localhost (Android).
const CORS_ORIGINS=new Set(String(process.env.CORS_ORIGINS||"capacitor://localhost,ionic://localhost,http://localhost,https://localhost").split(",").map(x=>x.trim()).filter(Boolean));
function corsHeaders(req){
  const origin=req.headers.origin;
  if(!origin||!CORS_ORIGINS.has(origin))return {};
  return {"Access-Control-Allow-Origin":origin,"Vary":"Origin","Access-Control-Allow-Headers":"Content-Type, X-Free-Client, X-Telegram-Init-Data","Access-Control-Allow-Methods":"GET, POST, PUT, DELETE, OPTIONS","Access-Control-Max-Age":"86400"};
}
function send(res,status,body,type="text/plain; charset=utf-8"){
  res.writeHead(status,{"Content-Type":type,"Cache-Control":"no-store",...corsHeaders(res.req)});
  res.end(body);
}
function json(res,status,obj){send(res,status,JSON.stringify(obj),"application/json; charset=utf-8")}
async function readBody(req,max=160000){
  const chunks=[];let size=0;
  for await(const c of req){size+=c.length;if(size>max)throw new Error("body too large");chunks.push(c)}
  return Buffer.concat(chunks).toString("utf8");
}
function cacheKey(args){return JSON.stringify(args)}

const PAGE_META_CACHE=new Map();
function safeRemoteUrl(raw){
  try{
    const u=new URL(raw);if(!/^https?:$/.test(u.protocol))return null;
    const h=u.hostname.toLowerCase();
    if(h==="localhost"||h==="127.0.0.1"||h==="0.0.0.0"||h.endsWith(".local"))return null;
    if(/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h))return null;
    return u;
  }catch{return null}
}
function absUrl(base,raw){try{return new URL(raw,base).href}catch{return null}}
function htmlAttr(tag,name){
  const m=tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`,"i"));return m?m[1]:null;
}
async function pageMeta(raw){
  const u=safeRemoteUrl(raw);if(!u)return {};
  const hit=PAGE_META_CACHE.get(u.href);if(hit&&Date.now()-hit.at<30*60*1000)return hit.value;
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),2200);
  try{
    const resp=await fetch(u,{signal:ctrl.signal,headers:{"User-Agent":"FREE-Moscow/1.0 (+local prototype)","Accept":"text/html,application/xhtml+xml"}});
    if(!resp.ok)return {};
    if(!(resp.headers.get("content-type")||"").includes("text/html"))return {};
    let html=await resp.text();if(html.length>900000)html=html.slice(0,900000);
    let image=null;
    for(const tag of html.match(/<meta\b[^>]*>/gi)||[]){
      const prop=(htmlAttr(tag,"property")||htmlAttr(tag,"name")||"").toLowerCase();
      if(prop==="og:image"||prop==="twitter:image"){image=absUrl(resp.url,htmlAttr(tag,"content"));if(image)break}
    }
    let booking_url=null,booking_kind=null,booking_provider=null;
    for(const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
      const href=htmlAttr(m[1],"href");if(!href)continue;
      const text=String(m[2]||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
      const full=absUrl(resp.url,href);if(!full)continue;
      const hay=(text+" "+full).toLowerCase();
      if(/заброни|брониров|booking|reserve|reservation|купить билет|билеты|tickets|telegram|whatsapp|t\.me|wa\.me/.test(hay)){
        booking_url=full;
        booking_kind=/t\.me|telegram/.test(hay)?"telegram":/wa\.me|whatsapp/.test(hay)?"whatsapp":/билет|ticket/.test(hay)?"tickets":"site";
        booking_provider=booking_kind==="telegram"?"Telegram":booking_kind==="whatsapp"?"WhatsApp":booking_kind==="tickets"?"билетный сервис":"форма бронирования";
        break;
      }
    }
    const value={image_url:image,booking_url,booking_kind,booking_provider};
    PAGE_META_CACHE.set(u.href,{at:Date.now(),value});return value;
  }catch{return {}}finally{clearTimeout(timer)}
}
// Прокси картинок: многие сайты блокируют хотлинки и отдают http, а страница у нас https.
const IMG_MAX=3*1024*1024;
async function proxyImage(res,raw){
  const u=safeRemoteUrl(raw);if(!u)return send(res,400,"bad url");
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),6000);
  try{
    const r=await fetch(u,{signal:ctrl.signal,redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 (compatible; FREE-Moscow/1.0)","Accept":"image/avif,image/webp,image/*,*/*;q=0.5","Referer":u.origin+"/"}});
    const type=(r.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
    if(!r.ok||!/^image\//.test(type))return send(res,415,"not an image");
    const len=Number(r.headers.get("content-length")||0);if(len>IMG_MAX)return send(res,413,"too large");
    const buf=Buffer.from(await r.arrayBuffer());if(buf.length>IMG_MAX)return send(res,413,"too large");
    res.writeHead(200,{"Content-Type":type,"Cache-Control":"public, max-age=86400","Content-Length":String(buf.length),"X-Content-Type-Options":"nosniff",...corsHeaders(res.req)});
    return res.end(buf);
  }catch(e){return send(res,502,"image unavailable")}finally{clearTimeout(timer)}
}
async function enrichResults(payload){
  const results=payload.results||[];
  const enriched=await Promise.all(results.map(async (x,i)=>{
    if(i>4)return x;
    const target=x.official_source||x.point_source||x.source;
    if(!target|| (x.image_url&&x.booking_url))return x;
    const meta=await pageMeta(target);
    return {...x,
      image_url:x.image_url||meta.image_url||null,
      booking_url:x.booking_url||meta.booking_url||null,
      booking_kind:x.booking_kind||meta.booking_kind||null,
      booking_provider:x.booking_provider||meta.booking_provider||null
    };
  }));
  return {...payload,results:enriched};
}

async function recommend(args){
  const key=cacheKey(args),hit=CACHE.get(key);
  if(hit&&Date.now()-hit.at<CACHE_MS)return {...hit.value,cached:true};
  const live=await searchLiveInventory(args,process.env);
  const ranked=rankLive(live.items,args,live.plan);
  const base={...resultPayload(ranked,live),errors:live.errors,plan:{placeQueries:live.plan.placeQueries,eventQueries:live.plan.eventQueries},fresh_at:new Date().toISOString()};
  const value=await enrichResults(base);
  CACHE.set(key,{at:Date.now(),value});
  return value;
}

const recommendTool={
  name:"recommend_free",
  description:"Ищет реальные заведения и мероприятия Москвы в live-источниках FREE (KudaGo, Timepad, OpenStreetMap, 2GIS). Вызывай перед любой рекомендацией, куда пойти, где поесть, выпить, покурить кальян, послушать музыку, посмотреть событие и т.п. Возвращает только факты из источников.",
  input_schema:{
    type:"object",
    properties:{
      query:{type:"string",description:"Полный смысл запроса пользователя по-русски."},
      party_size:{type:"integer",minimum:1,maximum:20},
      after_time:{type:"string",description:"Самое раннее время HH:MM, если известно."},
      target_date:{type:"string",description:"Дата YYYY-MM-DD, если известна."},
      max_price_rub:{type:"integer",minimum:0},
      interests:{type:"array",items:{type:"string"}},
      exclusions:{type:"array",items:{type:"string"}},
      area:{type:"string",description:"Район, метро или часть Москвы."},
      weather_context:{type:"object",properties:{rain:{type:"boolean"},temperature_c:{type:"number"}},description:"Контекст погоды, если он нужен запросу."}
    },
    required:["query"]
  }
};

const planTool={
  name:"plan_evening",
  description:"Собирает связку из 2–4 точек на вечер (например: ужин → бар → кальян) с реальными местами, временем каждой точки, переходами между ними и маршрутом. Вызывай, когда пользователь просит план на вечер, несколько активностей подряд («поужинать, а потом в бар»), или хочет продолжить вечер после выбранного места (тогда одна остановка + anchor = координаты выбранного места и start_time = время его окончания). Для одиночного запроса «куда пойти» используй recommend_free.",
  input_schema:{
    type:"object",
    properties:{
      stops:{type:"array",minItems:1,maxItems:4,items:{type:"object",properties:{query:{type:"string",description:"Что искать на этом шаге, по-русски: «ужин ресторан итальянская кухня», «коктейльный бар», «кальянная»"},duration_min:{type:"integer",minimum:15,maximum:300}},required:["query"]},description:"Остановки по порядку."},
      start_time:{type:"string",description:"Начало вечера HH:MM. По умолчанию 19:00."},
      target_date:{type:"string",description:"Дата YYYY-MM-DD, если известна."},
      party_size:{type:"integer",minimum:1,maximum:20},
      max_price_rub:{type:"integer",minimum:0,description:"Бюджет на человека на весь вечер, если назван."},
      anchor:{type:"object",properties:{lat:{type:"number"},lon:{type:"number"}},description:"Точка старта: координаты пользователя или выбранного места."},
      area:{type:"string",description:"Район или метро, если пользователь назвал."}
    },
    required:["stops"]
  }
};
function planId(){return randomUUID().replace(/-/g,"").slice(0,10)}
function sharePlan(plan,meta={}){
  const id=planId();
  const stops=(plan.stops||[]).map(s=>({...s,alternatives:[]}));
  store.setShared(id,{id,created_at:new Date().toISOString(),title:meta.title||"Вечер с FREE",date:meta.date||null,plan:{...plan,stops}});
  return id;
}
async function planEvening(args,context={}){
  const req={...args};
  if(req.area&&Array.isArray(req.stops))req.stops=req.stops.map(s=>({...s,query:`${s.query} ${req.area}`}));
  if(context.taste_weights&&typeof context.taste_weights==="object")req.taste_weights=context.taste_weights;
  if(!req.anchor&&context.user_location&&Number.isFinite(+context.user_location.lat))req.anchor={lat:+context.user_location.lat,lon:+context.user_location.lon};
  const now=new Date();
  const msk=new Intl.DateTimeFormat("ru-RU",{timeZone:"Europe/Moscow",hour:"2-digit",minute:"2-digit",hour12:false}).format(now).split(":").map(Number);
  req.now_min=Math.max(msk[0]*60+msk[1]+30,18*60);
  return buildPlan(req,recommend);
}
function planForModel(plan){
  return {status:plan.status,total:plan.total,summary:planSummary(plan),
    stops:(plan.stops||[]).map(s=>({index:s.index,query:s.query,slot:`${s.slot_start}–${s.slot_end}`,travel_in:s.travel_in,conflict:s.conflict,
      place:s.place?{id:s.place.id,name:s.place.name,category:s.place.category,area:s.place.area,metro:s.place.metro,time:s.place.time,price:s.place.price,availability:s.place.availability,booking_kind:s.place.booking_kind}:null,
      alternatives:(s.alternatives||[]).map(a=>({id:a.id,name:a.name,category:a.category,area:a.area}))}))};
}
function escapeHtml(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function sharedPlanPage(rec){
  const p=rec.plan,e=escapeHtml;
  const rows=(p.stops||[]).map(s=>{
    const pl=s.place;
    const travel=s.travel_to_next?`<div class="travel">↓ ${s.travel_to_next.mode==="walk"?"пешком":s.travel_to_next.mode==="taxi"?"такси":"переход"} ~${s.travel_to_next.minutes} мин${s.travel_to_next.km?` · ${s.travel_to_next.km} км`:""}</div>`:"";
    return `<div class="stop"><div class="time">${e(s.slot_start)}–${e(s.slot_end)}</div><div class="body"><h3>${pl?e(pl.name):e(s.query)+" — не найдено"}</h3>${pl?`<p>${e(pl.category||"")}${pl.area?" · "+e(pl.area):""}${pl.metro?" · м. "+e(pl.metro):""}</p><p class="muted">${e(pl.price||"")}${pl.availability?" · "+e(pl.availability):""}</p>${pl.booking_url||pl.source?`<a href="${e(pl.booking_url||pl.source)}" target="_blank" rel="noopener">${pl.booking_url?"Бронь / билеты":"Страница места"}</a>`:""}`:""}</div></div>${travel}`;
  }).join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(rec.title)} · FREE</title>
<style>body{margin:0;font-family:-apple-system,Inter,Segoe UI,Roboto,sans-serif;background:#f6f6f4;color:#111214}main{max-width:560px;margin:0 auto;padding:24px 16px 48px}.eyebrow{font-size:11px;letter-spacing:.14em;color:#727780;text-transform:uppercase}h1{font-size:28px;margin:6px 0 4px}.sub{color:#727780;margin:0 0 20px}.stop{display:flex;gap:14px;background:#fff;border:1px solid rgba(20,24,28,.08);border-radius:18px;padding:14px 16px;box-shadow:0 10px 30px rgba(31,36,46,.06)}.time{min-width:92px;font-weight:700;font-variant-numeric:tabular-nums}.body h3{margin:0 0 4px;font-size:17px}.body p{margin:2px 0;font-size:13px}.muted{color:#727780}.body a{display:inline-block;margin-top:8px;font-size:13px;color:#315fff;text-decoration:none;font-weight:600}.travel{padding:8px 0 8px 108px;color:#727780;font-size:12px}.cta{display:flex;gap:10px;margin-top:22px;flex-wrap:wrap}.cta a{flex:1;text-align:center;padding:13px 16px;border-radius:14px;text-decoration:none;font-weight:700;font-size:14px}.cta .dark{background:#111316;color:#fff}.cta .light{background:#fff;color:#111214;border:1px solid rgba(20,24,28,.12)}.foot{margin-top:28px;font-size:12px;color:#727780}</style></head>
<body><main><div class="eyebrow">План вечера</div><h1>${e(rec.title)}</h1><p class="sub">${e(p.total?.start||"")}–${e(p.total?.end||"")}${rec.date?" · "+e(rec.date):""}${p.total?.travel_km?" · переходы "+e(String(p.total.travel_km))+" км":""}</p>
${rows}
<div class="cta">${p.route_url?`<a class="dark" href="${e(p.route_url)}" target="_blank" rel="noopener">Маршрут в Яндекс Картах</a>`:""}<a class="light" href="/">Собрать свой вечер в FREE</a></div>
<div class="foot">Составлено FREE по данным KudaGo, Timepad, OpenStreetMap и официальных сайтов. Часы и наличие мест стоит перепроверить у заведения.</div></main></body></html>`;
}

const TEXT_MODEL=process.env.CLAUDE_MODEL||"claude-opus-5";
const TEXT_EFFORT=process.env.CLAUDE_EFFORT||"medium";
const AI_READY=Boolean(process.env.ANTHROPIC_API_KEY);
let anthropic=AI_READY?new Anthropic():null;
export function setDialogueClient(client){anthropic=client}

// История диалога хранится на сервере: Messages API не имеет состояния, а интерфейс
// передаёт только идентификатор (поле previous_response_id / response_id).
const CONVERSATION_TTL_MS=2*60*60*1000;
const CONVERSATION_MAX_MESSAGES=40;
function conversationGet(id){return store.getConversation(id,CONVERSATION_TTL_MS)}
function conversationTrim(messages){
  // Режем историю только по границе обычной реплики пользователя, чтобы не разорвать пару tool_use / tool_result.
  while(messages.length>CONVERSATION_MAX_MESSAGES){
    const cut=messages.findIndex((m,i)=>i>0&&m.role==="user"&&typeof m.content==="string");
    if(cut<=0)break;
    messages.splice(0,cut);
  }
  return messages;
}
setInterval(()=>store.sweepConversations(CONVERSATION_TTL_MS),10*60*1000).unref();

function dialogueContextSummary(context={}){
  const selected=context.selected_place?{
    name:context.selected_place.name,
    category:context.selected_place.category,
    area:context.selected_place.area,
    time:context.selected_place.time,
    price:context.selected_place.price,
    coords:context.selected_place.coords||null,
    slot_end:context.selected_place.slot_end||null
  }:null;
  const plan=Array.isArray(context.plan)?context.plan.slice(0,6).map(x=>({
    name:x.name,category:x.category,area:x.area,time:x.time,price:x.price
  })):[];
  return JSON.stringify({
    taste_weights:context.taste_weights||{},
    selected_place:selected,
    current_plan:plan,
    has_user_location:Boolean(context.user_location)
  });
}

// Стабильная часть системного промпта кешируется; изменчивый UI-контекст идёт отдельным блоком после неё.
const DIALOGUE_SYSTEM=[
  "Ты FREE — разговорный AI-агент для выбора реальных мест, заведений и мероприятий в Москве.",
  "Главный интерфейс — свободный диалог, а не анкета и не фиксированный сценарий.",
  "Понимай обычную человеческую речь, в том числе короткие, разговорные и неидеальные формулировки.",
  "Не прогоняй пользователя через обязательный чек-лист вопросов.",
  "Задавай максимум ОДИН короткий вопрос за один ход и только если ответ реально изменит выбор.",
  "Если контекста уже достаточно — не спрашивай лишнего, сразу вызывай recommend_free.",
  "Если пользователь говорит «хочу выпить», можно уточнить один действительно важный параметр, например атмосферу или компанию. После ответа обычно переходи к поиску; не заставляй пользователя отдельно сообщать бюджет, район и время.",
  "Если пользователь меняет тему — например после кальяна пишет «теперь хочу потанцевать» — это новое намерение. Не переноси старый intent автоматически.",
  "Используй выбранное место как контекст только если пользователь явно связывает следующий запрос с ним словами вроде «после этого», «рядом», «а потом», «продолжить вечер».",
  "Когда пользователь просит куда пойти, где поесть, выпить, покурить кальян, потанцевать, сходить на событие или провести время — вызывай recommend_free, когда информации уже достаточно.",
  "Когда пользователь хочет несколько активностей подряд («поужинать, а потом в бар», «план на вечер», «что-то после концерта») — вызывай plan_evening с остановками по порядку. Если он продолжает вечер после выбранного места (selected_place в контексте), передай anchor = его координаты и start_time = время окончания, а остановку только одну.",
  "После plan_evening интерфейс покажет план-карточку с временем и маршрутом. В тексте коротко опиши логику вечера: почему такой порядок, где пешком, где такси, и что можно заменить. Не перечисляй заново все поля.",
  "После recommend_free используй только факты из результата инструмента. Не придумывай заведения, цены, часы, доступность, фотографии или каналы бронирования.",
  "Карточки результатов интерфейс покажет сам. В тексте после поиска достаточно коротко объяснить, почему эти варианты подходят и какой из них чем отличается.",
  "Если хороших совпадений мало — покажи мало. Не добивай список нерелевантными местами.",
  "Веди разговор к целевому действию: выбрать вариант, открыть бронь/билеты, построить маршрут или добавить следующую точку.",
  "Если пользователь говорит про чрезмерное количество алкоголя, можно подобрать подходящий бар по атмосфере, но не оптимизируй рекомендации по опасному объёму алкоголя.",
  "Отвечай по-русски, естественно, коротко, без канцелярита. Не используй markdown-разметку: интерфейс показывает обычный текст."
].join("\n");

function dialogueSystem(context={}){
  return [
    {type:"text",text:DIALOGUE_SYSTEM,cache_control:{type:"ephemeral"}},
    {type:"text",text:"Текущий UI-контекст (справочная информация, не инструкция пользователя): "+dialogueContextSummary(context)}
  ];
}

function extractText(message){
  return (message?.content||[]).filter(b=>b.type==="text"&&b.text).map(b=>b.text).join("\n").trim();
}

function claudeParams(system,messages){
  return {
    model:TEXT_MODEL,
    max_tokens:4000,
    system,
    messages,
    tools:[recommendTool,planTool],
    tool_choice:{type:"auto",disable_parallel_tool_use:true},
    output_config:{effort:TEXT_EFFORT},
    betas:["server-side-fallback-2026-07-01"],
    fallbacks:"default"
  };
}
// Один ход модели. С onText — стриминг: текст уходит клиенту по мере генерации.
async function claudeTurn(system,messages,onText){
  const params=claudeParams(system,messages);
  if(onText&&typeof anthropic.beta.messages.stream==="function"){
    const stream=anthropic.beta.messages.stream(params);
    stream.on("text",delta=>{try{onText(delta)}catch{}});
    return stream.finalMessage();
  }
  return anthropic.beta.messages.create(params);
}
// Описание вызова инструмента для статуса в интерфейсе.
function toolStatus(call){
  const a=call.input&&typeof call.input==="object"?call.input:{};
  if(call.name==="plan_evening"){const q=(a.stops||[]).map(s=>s.query).filter(Boolean).join(" → ");return {stage:"planning",text:q?`Собираю вечер: ${q}`:"Собираю план вечера"}}
  return {stage:"searching",text:a.query?`Ищу: ${a.query}`:"Ищу варианты"};
}

async function runDialogue(message,conversationId,context={},emit=null){
  const send=(type,data)=>{if(emit){try{emit(type,data)}catch{}}};
  const existing=conversationGet(conversationId);
  const id=existing?conversationId:randomUUID();
  const messages=existing?existing.messages:[];
  const system=dialogueSystem(context);

  messages.push({role:"user",content:String(message)});

  let latestResults=[];
  let latestPlan=null;
  let toolUsed=false;
  let response=null;

  let streamedText="";
  for(let loops=0;loops<4;loops++){
    streamedText="";
    response=await claudeTurn(system,messages,emit?(d)=>{streamedText+=d;send("delta",{text:d})}:null);
    messages.push({role:"assistant",content:response.content});

    if(response.stop_reason==="refusal"||response.stop_reason==="max_tokens")break;
    if(response.stop_reason==="pause_turn")continue;

    const calls=response.content.filter(b=>b.type==="tool_use");
    if(!calls.length)break;
    // Промежуточный текст перед инструментом уже ушёл дельтами; следующий ход начнёт новый абзац.
    if(streamedText.trim())send("break",{});

    const results=[];
    for(const call of calls){
      const args=(call.input&&typeof call.input==="object")?{...call.input}:{};
      send("status",toolStatus(call));
      if(call.name==="plan_evening"){
        toolUsed=true;
        try{
          const plan=await planEvening(args,context);
          latestPlan=plan;
          latestResults=(plan.stops||[]).map(s=>s.place).filter(Boolean);
          results.push({type:"tool_result",tool_use_id:call.id,content:JSON.stringify(planForModel(plan))});
        }catch(e){
          results.push({type:"tool_result",tool_use_id:call.id,is_error:true,content:`plan_failed: ${e.message}`});
        }
        continue;
      }
      if(call.name!=="recommend_free"){
        results.push({type:"tool_result",tool_use_id:call.id,is_error:true,content:"unknown tool"});
        continue;
      }
      toolUsed=true;
      if(!args.query)args.query=String(message);
      if(context.taste_weights&&typeof context.taste_weights==="object")args.taste_weights=context.taste_weights;
      if(context.user_location&&Number.isFinite(+context.user_location.lat)&&Number.isFinite(+context.user_location.lon)){
        args.user_location={lat:+context.user_location.lat,lon:+context.user_location.lon};
      }
      try{
        const result=await recommend(args);
        latestResults=(result.results||[]).slice(0,5);
        results.push({type:"tool_result",tool_use_id:call.id,content:JSON.stringify({
          status:result.status,count:result.count,note:result.note||null,results:latestResults
        })});
      }catch(e){
        results.push({type:"tool_result",tool_use_id:call.id,is_error:true,content:`providers_unavailable: ${e.message}`});
      }
    }
    messages.push({role:"user",content:results});
  }

  let reply=extractText(response);
  const streamedFinal=streamedText.trim().length>0;
  if(response?.stop_reason==="refusal"){
    reply="С этим запросом помочь не смогу. Давайте подберём что-то другое: место, событие или формат вечера.";
  }
  if(!reply){
    reply=latestResults.length
      ?"Нашёл несколько подходящих вариантов. Посмотрите карточки ниже — помогу выбрать между ними."
      :"Расскажите чуть подробнее, что сейчас для вас важнее.";
  }

  store.setConversation(id,conversationTrim(messages),context.user_id||null);

  return {
    reply,
    reply_streamed:streamedFinal&&reply===streamedText.trim(),
    response_id:id,
    results:latestResults,
    plan:latestPlan,
    tool_used:toolUsed,
    model:response?.model||TEXT_MODEL
  };
}

function dialogueError(e){
  if(e instanceof Anthropic.AuthenticationError)return {status:502,error:"dialogue_auth",message:"Неверный ANTHROPIC_API_KEY"};
  if(e instanceof Anthropic.RateLimitError)return {status:503,error:"dialogue_rate_limited",message:"Лимит запросов к Claude, попробуйте чуть позже"};
  if(e instanceof Anthropic.BadRequestError)return {status:502,error:"dialogue_bad_request",message:e.message};
  if(e instanceof Anthropic.APIError)return {status:502,error:"dialogue_failed",message:`Claude API ${e.status}: ${e.message}`};
  return {status:502,error:"dialogue_failed",message:e.message};
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);
    res.req=req;
    if(req.method==="OPTIONS"){res.writeHead(204,corsHeaders(req));return res.end()}

    if(req.method==="GET"&&url.pathname==="/api/health"){
      return json(res,200,{
        ok:true,
        text_ai_ready:AI_READY,
        text_ai_model:TEXT_MODEL,
        telegram_auth:TG_REQUIRED,
        voice_ready:false,
        voice_model:null,
        providers:{kudago:true,timepad:true,osm:true,dgis:Boolean(process.env.DGIS_API_KEY||process.env.TWOGIS_API_KEY)}
      });
    }

    if(req.method==="POST"&&url.pathname==="/api/dialogue"){
      if(!AI_READY)return json(res,503,{error:"ANTHROPIC_API_KEY not set",fallback:true});
      const auth=authorize(req);if(auth.error)return json(res,auth.error.status,auth.error);
      const rl=dialogueLimiter.check(auth.user?.id?`tg:${auth.user.id}`:`ip:${clientKey(req)}`);
      if(!rl.ok){res.setHeader("Retry-After",String(rl.retryAfterSec));return json(res,429,{error:"rate_limited",message:"Слишком много сообщений, подождите немного",retry_after:rl.retryAfterSec})}
      let body={};
      try{body=JSON.parse(await readBody(req,240000))}catch{return json(res,400,{error:"invalid_json"})}
      const message=String(body.message||"").trim();
      if(!message)return json(res,400,{error:"message_required"});
      const me=identify(req,auth);
      try{
        return json(res,200,await runDialogue(message,body.previous_response_id||null,{...(body.context||{}),user_id:me?.id||null}));
      }catch(e){
        console.error("dialogue:",e);
        const err=dialogueError(e);
        return json(res,err.status,{error:err.error,message:err.message,fallback:true});
      }
    }

    // ---- Профиль и память ----
    if(url.pathname==="/api/me"||url.pathname.startsWith("/api/me/")){
      const auth=authorize(req);if(auth.error)return json(res,auth.error.status,auth.error);
      const me=identify(req,auth);
      if(!me)return json(res,400,{error:"client_required",message:"Нужен заголовок X-Free-Client или вход через Telegram"});
      if(req.method==="GET"&&url.pathname==="/api/me"){
        return json(res,200,{user:{id:me.id,first_name:me.first_name,telegram:Boolean(me.tg_id)},profile:store.getProfile(me.id),evenings:store.evenings(me.id,10),stats:store.stats(me.id),conversation_id:store.lastConversationId(me.id)});
      }
      if(req.method==="PUT"&&url.pathname==="/api/me"){
        let body={};try{body=JSON.parse(await readBody(req,400000))}catch{return json(res,400,{error:"invalid_json"})}
        return json(res,200,{profile:store.updateProfile(me.id,{taste:body.taste,saved:body.saved,plan:body.plan})});
      }
      if(req.method==="POST"&&url.pathname==="/api/me/event"){
        let body={};try{body=JSON.parse(await readBody(req))}catch{return json(res,400,{error:"invalid_json"})}
        const type=String(body.type||"").slice(0,20);if(!type)return json(res,400,{error:"type_required"});
        const taste=store.learn(me.id,type,body.dna&&typeof body.dna==="object"?body.dna:{},{place_id:body.place_id||null,name:String(body.name||"").slice(0,120)});
        return json(res,200,{taste});
      }
      if(req.method==="POST"&&url.pathname==="/api/me/evenings"){
        let body={};try{body=JSON.parse(await readBody(req,240000))}catch{return json(res,400,{error:"invalid_json"})}
        if(!body.plan||!Array.isArray(body.plan.stops)||!body.plan.stops.length)return json(res,400,{error:"plan_required"});
        const id=store.addEvening(me.id,body.plan,{title:String(body.title||"").slice(0,80)||null,date:String(body.date||"").slice(0,10)||null});
        return json(res,201,{id,evenings:store.evenings(me.id,10)});
      }
      const del=url.pathname.match(/^\/api\/me\/evenings\/([a-f0-9]{6,16})$/);
      if(req.method==="DELETE"&&del){return json(res,200,{ok:store.removeEvening(me.id,del[1]),evenings:store.evenings(me.id,10)})}
      return json(res,404,{error:"not_found"});
    }

    if(req.method==="POST"&&url.pathname==="/api/plan"){
      let body={};
      try{body=JSON.parse(await readBody(req))}catch{return json(res,400,{error:"invalid_json"})}
      if(!Array.isArray(body.stops)||!body.stops.length)return json(res,400,{error:"stops_required"});
      const auth=authorize(req);if(auth.error)return json(res,auth.error.status,auth.error);
      try{return json(res,200,await planEvening(body,body.context||{}))}
      catch(e){console.error(e);return json(res,502,{error:"plan_failed",message:e.message})}
    }

    if(req.method==="POST"&&url.pathname==="/api/plan/share"){
      let body={};
      try{body=JSON.parse(await readBody(req,240000))}catch{return json(res,400,{error:"invalid_json"})}
      if(!body.plan||!Array.isArray(body.plan.stops)||!body.plan.stops.length)return json(res,400,{error:"plan_required"});
      const id=sharePlan(body.plan,{title:String(body.title||"").slice(0,80),date:String(body.date||"").slice(0,10)||null});
      const origin=(req.headers["x-forwarded-proto"]||"http")+"://"+(req.headers["x-forwarded-host"]||req.headers.host||`localhost:${PORT}`);
      return json(res,201,{id,url:`${origin}/p/${id}`});
    }

    if(req.method==="GET"&&/^\/api\/plan\/[a-z0-9]{6,20}$/.test(url.pathname)){
      const rec=store.getShared(url.pathname.split("/").pop());
      return rec?json(res,200,rec):json(res,404,{error:"not_found"});
    }

    if(req.method==="GET"&&/^\/p\/[a-z0-9]{6,20}$/.test(url.pathname)){
      const rec=store.getShared(url.pathname.split("/").pop());
      if(!rec)return send(res,404,"План не найден или удалён");
      return send(res,200,sharedPlanPage(rec),"text/html; charset=utf-8");
    }

    if(req.method==="POST"&&url.pathname==="/api/dialogue/stream"){
      if(!AI_READY)return json(res,503,{error:"ANTHROPIC_API_KEY not set",fallback:true});
      const auth=authorize(req);if(auth.error)return json(res,auth.error.status,auth.error);
      const rl=dialogueLimiter.check(auth.user?.id?`tg:${auth.user.id}`:`ip:${clientKey(req)}`);
      if(!rl.ok){res.setHeader("Retry-After",String(rl.retryAfterSec));return json(res,429,{error:"rate_limited",message:"Слишком много сообщений, подождите немного",retry_after:rl.retryAfterSec})}
      let body={};
      try{body=JSON.parse(await readBody(req,240000))}catch{return json(res,400,{error:"invalid_json"})}
      const message=String(body.message||"").trim();
      if(!message)return json(res,400,{error:"message_required"});
      res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store","Connection":"keep-alive","X-Accel-Buffering":"no",...corsHeaders(req)});
      const emit=(type,data)=>{if(!res.writableEnded)res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)};
      const ping=setInterval(()=>{if(!res.writableEnded)res.write(": ping\n\n")},15000);
      const me=identify(req,auth);
      try{
        const result=await runDialogue(message,body.previous_response_id||null,{...(body.context||{}),user_id:me?.id||null},emit);
        emit("done",result);
      }catch(e){
        console.error("dialogue/stream:",e);
        const err=dialogueError(e);
        emit("error",{error:err.error,message:err.message,fallback:true});
      }finally{clearInterval(ping);res.end()}
      return;
    }

    if(req.method==="POST"&&url.pathname==="/api/recommend"){
      let args={};
      try{args=JSON.parse(await readBody(req))}catch{return json(res,400,{error:"invalid_json"})}
      if(!String(args.query||"").trim())return json(res,400,{error:"query_required"});
      const auth=authorize(req);if(auth.error)return json(res,auth.error.status,auth.error);
      try{return json(res,200,await recommend(args))}
      catch(e){console.error(e);return json(res,502,{error:"providers_unavailable",message:e.message})}
    }

    if(req.method==="GET"&&url.pathname==="/api/img"){
      return proxyImage(res,url.searchParams.get("u")||"");
    }

    if(req.method==="GET"&&url.pathname==="/api/weather"){
      const lat=Number(url.searchParams.get("lat")||55.7558),lon=Number(url.searchParams.get("lon")||37.6173);
      if(!Number.isFinite(lat)||!Number.isFinite(lon))return json(res,400,{error:"bad_coordinates"});
      try{
        const u=new URL("https://api.open-meteo.com/v1/forecast");
        u.searchParams.set("latitude",String(lat));u.searchParams.set("longitude",String(lon));
        u.searchParams.set("current","temperature_2m,precipitation,rain");
        u.searchParams.set("hourly","precipitation_probability,rain");
        u.searchParams.set("forecast_days","3");u.searchParams.set("timezone","Europe/Moscow");
        const wr=await fetch(u);if(!wr.ok)throw new Error("weather "+wr.status);
        const w=await wr.json();
        const maxProb=Math.max(0,...(w.hourly?.precipitation_probability||[]).slice(0,48));
        return json(res,200,{temperature_c:w.current?.temperature_2m??null,rain:Boolean((w.current?.rain||0)>0||(w.current?.precipitation||0)>0||maxProb>=55),precipitation_probability_max:maxProb});
      }catch(e){return json(res,502,{error:"weather_unavailable",message:e.message})}
    }

    // Голосовой WebRTC-режим был привязан к OpenAI Realtime; у Claude такого канала нет.
    // Интерфейс использует распознавание речи браузера и отправляет текст в /api/dialogue.
    if(req.method==="POST"&&url.pathname==="/api/live-session"){
      return json(res,501,{error:"voice_not_supported",message:"Голосовой режим работает через распознавание речи в браузере"});
    }

    if(req.method!=="GET")return send(res,405,"Method not allowed");
    let pathname=url.pathname==="/"?"/index.html":url.pathname;
    const safe=normalize(pathname).replace(/^(\.\.[/\\])+/g,"");
    const file=join(PUBLIC,safe);
    if(!file.startsWith(PUBLIC))return send(res,403,"Forbidden");
    try{
      const data=await readFile(file);
      return send(res,200,data,mime[extname(file)]||"application/octet-stream");
    }catch{
      return send(res,404,"Not found");
    }
  }catch(e){
    console.error(e);
    return json(res,500,{error:"server_error",message:e.message});
  }
});

export {runDialogue,conversationTrim,recommendTool,planTool,dialogueSystem,sharePlan,sharedPlanPage,planEvening,server,store,identify};

if(process.env.NODE_ENV!=="test"){
  server.listen(PORT,HOST,()=>{
    console.log(`FREE v18: http://${HOST}:${PORT}`);
    console.log("Telegram auth: "+(TG_REQUIRED?"required (TELEGRAM_BOT_TOKEN set)":"off"));
    console.log("Live providers: KudaGo + Timepad + OpenStreetMap/Overpass" + (process.env.DGIS_API_KEY||process.env.TWOGIS_API_KEY?" + 2GIS":""));
    console.log("Text AI: "+(AI_READY?`Claude ${TEXT_MODEL} ready`:"scripted fallback (ANTHROPIC_API_KEY not set)"));
    console.log("Voice: browser speech recognition → text dialogue");
  });
  startWarmup();
}
