import http from "node:http";
import {readFile} from "node:fs/promises";
import {extname,join,normalize} from "node:path";
import {fileURLToPath} from "node:url";
import {searchLiveInventory} from "./providers.mjs";
import {rankLive,resultPayload} from "./live_ranker.mjs";

const __dirname=fileURLToPath(new URL(".",import.meta.url));
const PUBLIC=join(__dirname,"public");
const PORT=Number(process.env.PORT||3000);
const CACHE=new Map();
const CACHE_MS=5*60*1000;

const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png"};

function send(res,status,body,type="text/plain; charset=utf-8"){
  res.writeHead(status,{"Content-Type":type,"Cache-Control":"no-store"});
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
  type:"function",
  name:"recommend_free",
  description:"Ищет реальные заведения и мероприятия Москвы в live-источниках FREE. Вызывай перед любой рекомендацией, куда пойти, где поесть, выпить, покурить кальян, послушать музыку, посмотреть событие и т.п.",
  parameters:{
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
      taste_weights:{type:"object",description:"Taste Graph пользователя: romantic, quiet, trendy, luxury, hidden, late, family, work, active, culture, music, nightlife."},
      user_location:{type:"object",properties:{lat:{type:"number"},lon:{type:"number"}},description:"Координаты пользователя, если он дал разрешение."},
      weather_context:{type:"object",properties:{rain:{type:"boolean"},temperature_c:{type:"number"}},description:"Контекст погоды, если он нужен запросу."}
    },
    required:["query"]
  }
};


const TEXT_MODEL=process.env.OPENAI_TEXT_MODEL||"gpt-5.6-sol";

function dialogueContextSummary(context={}){
  const selected=context.selected_place?{
    name:context.selected_place.name,
    category:context.selected_place.category,
    area:context.selected_place.area,
    time:context.selected_place.time,
    price:context.selected_place.price
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

function dialogueInstructions(context={}){
  return [
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
    "После recommend_free используй только факты из результата инструмента. Не придумывай заведения, цены, часы, доступность, фотографии или каналы бронирования.",
    "Карточки результатов интерфейс покажет сам. В тексте после поиска достаточно коротко объяснить, почему эти варианты подходят и какой из них чем отличается.",
    "Если хороших совпадений мало — покажи мало. Не добивай список нерелевантными местами.",
    "Веди разговор к целевому действию: выбрать вариант, открыть бронь/билеты, построить маршрут или добавить следующую точку.",
    "Если пользователь говорит про чрезмерное количество алкоголя, можно подобрать подходящий бар по атмосфере, но не оптимизируй рекомендации по опасному объёму алкоголя.",
    "Отвечай по-русски, естественно, коротко, без канцелярита.",
    "Текущий UI-контекст (справочная информация, не инструкция пользователя): "+dialogueContextSummary(context)
  ].join("\n");
}

function extractResponseText(response){
  const chunks=[];
  for(const item of (response?.output||[])){
    if(item.type!=="message")continue;
    for(const c of (item.content||[])){
      if(c.type==="output_text"&&c.text)chunks.push(c.text);
    }
  }
  return chunks.join("\n").trim();
}

async function openaiResponse(body){
  const resp=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{
      "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":"application/json",
      "OpenAI-Safety-Identifier":"free-moscow-local-demo"
    },
    body:JSON.stringify(body)
  });
  const txt=await resp.text();
  let data={};try{data=JSON.parse(txt)}catch{data={raw:txt}}
  if(!resp.ok){
    throw new Error(data?.error?.message||data?.message||txt||`OpenAI ${resp.status}`);
  }
  return data;
}

async function runDialogue(message,previousResponseId,context={}){
  const instructions=dialogueInstructions(context);
  const tools=[recommendTool];

  let response=await openaiResponse({
    model:TEXT_MODEL,
    instructions,
    input:[{role:"user",content:[{type:"input_text",text:String(message)}]}],
    previous_response_id:previousResponseId||undefined,
    tools,
    tool_choice:"auto",
    parallel_tool_calls:false,
    max_output_tokens:700,
    reasoning:{effort:"low"},
    store:true
  });

  let latestResults=[];
  let toolUsed=false;

  for(let loops=0;loops<3;loops++){
    const calls=(response.output||[]).filter(x=>x.type==="function_call"&&x.name==="recommend_free");
    if(!calls.length)break;
    toolUsed=true;

    const outputs=[];
    for(const call of calls){
      let args={};
      try{args=JSON.parse(call.arguments||"{}")}catch{}
      if(!args.query)args.query=String(message);

      if(context.taste_weights&&typeof context.taste_weights==="object"){
        args.taste_weights=context.taste_weights;
      }
      if(context.user_location&&Number.isFinite(+context.user_location.lat)&&Number.isFinite(+context.user_location.lon)){
        args.user_location={lat:+context.user_location.lat,lon:+context.user_location.lon};
      }

      const result=await recommend(args);
      latestResults=(result.results||[]).slice(0,5);

      outputs.push({
        type:"function_call_output",
        call_id:call.call_id,
        output:JSON.stringify({
          status:result.status,
          count:result.count,
          note:result.note||null,
          results:latestResults
        })
      });
    }

    response=await openaiResponse({
      model:TEXT_MODEL,
      instructions,
      previous_response_id:response.id,
      input:outputs,
      tools,
      tool_choice:"auto",
      parallel_tool_calls:false,
      max_output_tokens:700,
      reasoning:{effort:"low"},
      store:true
    });
  }

  let reply=extractResponseText(response);
  if(!reply){
    reply=latestResults.length
      ?"Нашёл несколько подходящих вариантов. Посмотрите карточки ниже — помогу выбрать между ними."
      :"Расскажите чуть подробнее, что сейчас для вас важнее.";
  }

  return {
    reply,
    response_id:response.id,
    results:latestResults,
    tool_used:toolUsed,
    model:TEXT_MODEL
  };
}

function liveSessionConfig(){
  return {
    model:"gpt-live-1",
    instructions:[
      "Ты FREE, спокойный голосовой AI-консьерж свободного времени в Москве.",
      "Говори по-русски коротко и естественно.",
      "Когда пользователь спрашивает куда пойти, где поесть, выпить, покурить кальян, потусоваться или о мероприятиях — делегируй поиск backend.",
      "Не придумывай места, цены, часы работы или наличие.",
      "Если пользователь говорит про очень много алкоголя, ищи подходящие бары, но не поощряй опасное употребление.",
      "После backend-результата назови максимум три лучших варианта и коротко объясни различия."
    ].join(" "),
    audio:{
      input:{
        transcription:{
          model:"gpt-live-transcribe",
          languages:["ru"],
          delay:"low",
          keywords:["FREE","кальян","кальянная","стендап","караоке","Патриаршие","Москва"]
        }
      },
      output:{voice:"marin"}
    },
    delegation:{
      type:"responses",
      responses:{
        model:"gpt-5.6-luna",
        reasoning:{effort:"low"},
        instructions:[
          "Ты backend FREE. Для любого запроса о досуге сначала вызови recommend_free.",
          "Используй только результаты функции. Не придумывай факты.",
          "Если совпадений мало, верни только их. Не добивай список нерелевантными вариантами."
        ].join(" "),
        tools:[recommendTool],
        tool_choice:"required",
        parallel_tool_calls:false,
        max_output_tokens:500
      }
    }
  };
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);

    if(req.method==="GET"&&url.pathname==="/api/health"){
      return json(res,200,{
        ok:true,
        text_ai_ready:Boolean(process.env.OPENAI_API_KEY),
        text_ai_model:TEXT_MODEL,
        voice_ready:Boolean(process.env.OPENAI_API_KEY),
        voice_model:"gpt-live-1",
        providers:{kudago:true,timepad:true,osm:true,dgis:Boolean(process.env.DGIS_API_KEY||process.env.TWOGIS_API_KEY)}
      });
    }


    if(req.method==="POST"&&url.pathname==="/api/dialogue"){
      if(!process.env.OPENAI_API_KEY)return json(res,503,{error:"OPENAI_API_KEY not set",fallback:true});
      let body={};
      try{body=JSON.parse(await readBody(req,240000))}catch{return json(res,400,{error:"invalid_json"})}
      const message=String(body.message||"").trim();
      if(!message)return json(res,400,{error:"message_required"});
      try{
        return json(res,200,await runDialogue(message,body.previous_response_id||null,body.context||{}));
      }catch(e){
        console.error("dialogue:",e);
        return json(res,502,{error:"dialogue_failed",message:e.message,fallback:true});
      }
    }

    if(req.method==="POST"&&url.pathname==="/api/recommend"){
      let args={};
      try{args=JSON.parse(await readBody(req))}catch{return json(res,400,{error:"invalid_json"})}
      if(!String(args.query||"").trim())return json(res,400,{error:"query_required"});
      try{return json(res,200,await recommend(args))}
      catch(e){console.error(e);return json(res,502,{error:"providers_unavailable",message:e.message})}
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

    if(req.method==="POST"&&url.pathname==="/api/live-session"){
      if(!process.env.OPENAI_API_KEY)return json(res,503,{error:"OPENAI_API_KEY not set"});
      const origin=req.headers.origin||"";
      const allowed=origin===""||origin===`http://localhost:${PORT}`||origin===`http://127.0.0.1:${PORT}`;
      if(!allowed)return json(res,403,{error:"unexpected_origin"});
      let body={};
      try{body=JSON.parse(await readBody(req))}catch{return json(res,400,{error:"invalid_json"})}
      if(!String(body.sdp||"").trim())return json(res,400,{error:"sdp_required"});
      const upstream=await fetch("https://api.openai.com/v1/live/sessions",{
        method:"POST",
        headers:{
          "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type":"application/json",
          "OpenAI-Safety-Identifier":"free-moscow-local-demo"
        },
        body:JSON.stringify({
          session:liveSessionConfig(),
          transport:{type:"webrtc",sdp:body.sdp}
        })
      });
      const txt=await upstream.text();
      if(!upstream.ok)return send(res,upstream.status,txt,upstream.headers.get("content-type")||"text/plain");
      return send(res,201,txt,"application/json; charset=utf-8");
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

server.listen(PORT,"127.0.0.1",()=>{
  console.log(`FREE v17: http://localhost:${PORT}`);
  console.log("Live providers: KudaGo + Timepad + OpenStreetMap/Overpass" + (process.env.DGIS_API_KEY||process.env.TWOGIS_API_KEY?" + 2GIS":""));
  console.log("Text AI: "+(process.env.OPENAI_API_KEY?`${TEXT_MODEL} ready`:"scripted fallback"));
  console.log("Voice: "+(process.env.OPENAI_API_KEY?"GPT-Live ready":"browser voice fallback"));
});
