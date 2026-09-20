// Защита исходящих запросов сервера.
//
// Сервер ходит на внешние адреса по данным, которые пришли снаружи: картинка
// места, сайт заведения из тега OSM (его правит кто угодно), ссылка бронирования.
// Без проверок это превращает наш прокси в инструмент для запросов во внутреннюю
// сеть — к самому серверу, к соседним сервисам, к метаданным облака.
//
// Три вещи, которых не хватало:
//   1) блокировался только литерал 127.0.0.1 — мимо проходили 127.0.0.2, ::1,
//      ::ffff:127.0.0.1, 100.64/10 и имя, которое РЕЗОЛВИТСЯ в приватный адрес;
//   2) redirect:"follow" уводил куда угодно уже ПОСЛЕ проверки;
//   3) тело читалось целиком в память до проверки размера.
import {lookup} from "node:dns/promises";

// Приватные, служебные и петлевые диапазоны.
export function isPrivateAddress(ip){
  const s=String(ip||"").toLowerCase().replace(/^\[|\]$/g,"");
  if(!s)return true;
  if(/^\d+\.\d+\.\d+\.\d+$/.test(s)){
    const p=s.split(".").map(Number);
    if(p.some(n=>!Number.isInteger(n)||n<0||n>255))return true;
    const [a,b]=p;
    if(a===0||a===10||a===127)return true;                       // this-network, private, loopback
    if(a===169&&b===254)return true;                             // link-local и метаданные облака
    if(a===192&&b===168)return true;
    if(a===172&&b>=16&&b<=31)return true;
    if(a===100&&b>=64&&b<=127)return true;                       // CGNAT
    if(a===192&&b===0)return true;                               // IETF protocol assignments
    if(a>=224)return true;                                       // multicast и зарезервированное
    return false;
  }
  if(s==="::"||s==="::1")return true;
  if(s.startsWith("::ffff:")){
    const tail=s.slice(7);
    return /^\d+\.\d+\.\d+\.\d+$/.test(tail)?isPrivateAddress(tail):true;
  }
  if(/^f[cd]/.test(s))return true;                               // fc00::/7 unique local
  if(/^fe[89ab]/.test(s))return true;                            // fe80::/10 link-local
  if(s.includes(":"))return false;                               // прочий IPv6 — публичный
  return true;                                                   // неизвестная форма — не рискуем
}

// Литерал адреса — это то, что можно проверить без DNS. Доменное имя проверяется
// отдельно, через resolvesPublic: для него isPrivateAddress неприменима.
export function isIpLiteral(host){
  const s=String(host||"").replace(/^\[|\]$/g,"");
  return /^\d+\.\d+\.\d+\.\d+$/.test(s)||s.includes(":");
}

const BAD_SUFFIX=/\.(local|internal|localdomain|home|lan|corp|intranet)$/i;

// Структурная проверка: без обращения к DNS.
export function safeRemoteUrl(raw){
  let u;
  try{u=new URL(String(raw))}catch{return null}
  if(!/^https?:$/.test(u.protocol))return null;
  if(u.username||u.password)return null;                         // user:pass@ прячет настоящий хост
  const host=u.hostname.toLowerCase().replace(/\.$/,"");         // завершающая точка — тот же хост
  if(!host||host==="localhost"||BAD_SUFFIX.test(host))return null;
  if(isIpLiteral(host)&&isPrivateAddress(host))return null;
  // Десятичная и восьмеричная записи адреса (http://2130706433/) — тоже loopback.
  if(/^\d+$/.test(host))return null;
  if(/^0[0-7]+(\.|$)/.test(host))return null;
  return u;
}

// Проверка по DNS: имя не должно резолвиться в приватный адрес.
export async function resolvesPublic(u,{lookupImpl=lookup}={}){
  const host=u.hostname.toLowerCase().replace(/\.$/,"");
  if(isIpLiteral(host))return !isPrivateAddress(host);            // проверено структурно
  try{
    const all=await lookupImpl(host,{all:true});
    const list=Array.isArray(all)?all:[all];
    if(!list.length)return false;
    return list.every(a=>!isPrivateAddress(a.address));
  }catch{return false}
}

/**
 * Запрос во внешнюю сеть с проверкой каждого перенаправления и лимитом на тело.
 * Возвращает {ok,status,headers,url,body:Buffer,truncated} либо {ok:false,reason}.
 */
export async function guardedFetch(raw,{
  maxBytes=3*1024*1024,timeoutMs=6000,maxRedirects=3,accept=null,
  fetchImpl=fetch,lookupImpl=lookup,headers={}
}={}){
  let url=String(raw);
  for(let hop=0;hop<=maxRedirects;hop++){
    const u=safeRemoteUrl(url);
    if(!u)return {ok:false,reason:"blocked_url"};
    if(!await resolvesPublic(u,{lookupImpl}))return {ok:false,reason:"private_address"};
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs);
    let r;
    try{
      // Перенаправления обрабатываем сами: только так каждый переход проходит проверку.
      r=await fetchImpl(u,{signal:ctrl.signal,redirect:"manual",headers:{"User-Agent":UA,...headers}});
    }catch(e){clearTimeout(timer);return {ok:false,reason:"fetch_failed",error:String(e&&e.message||e)}}
    if(r.status>=300&&r.status<400&&r.headers.get("location")){
      clearTimeout(timer);
      try{r.body&&r.body.cancel&&r.body.cancel()}catch{}
      url=new URL(r.headers.get("location"),u).href;
      continue;
    }
    const type=(r.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
    if(accept&&!accept(type)){clearTimeout(timer);try{r.body&&r.body.cancel&&r.body.cancel()}catch{}return {ok:false,reason:"bad_type",type}}
    const declared=Number(r.headers.get("content-length")||0);
    if(declared&&declared>maxBytes){clearTimeout(timer);try{r.body&&r.body.cancel&&r.body.cancel()}catch{}return {ok:false,reason:"too_large"}}
    // Тело читаем потоком и обрываем на лимите: Content-Length может врать или отсутствовать.
    const chunks=[];let size=0,truncated=false;
    try{
      if(r.body){
        for await(const chunk of r.body){
          const buf=Buffer.from(chunk);
          if(size+buf.length>maxBytes){chunks.push(buf.subarray(0,maxBytes-size));size=maxBytes;truncated=true;break}
          chunks.push(buf);size+=buf.length;
        }
      }
    }catch(e){clearTimeout(timer);return {ok:false,reason:"read_failed",error:String(e&&e.message||e)}}
    finally{clearTimeout(timer)}
    return {ok:r.ok,status:r.status,headers:r.headers,url:r.url||u.href,type,body:Buffer.concat(chunks),truncated};
  }
  return {ok:false,reason:"too_many_redirects"};
}

const UA="FREE-Moscow/1.0 (+https://afishasity.ru; консьерж по городу)";
export const USER_AGENT=UA;
