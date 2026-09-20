import {createHmac,timingSafeEqual} from "node:crypto";

// Проверка initData Telegram Mini App: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// secret = HMAC_SHA256(key="WebAppData", msg=bot_token); hash = HMAC_SHA256(key=secret, msg=data_check_string)
export function verifyInitData(initData,botToken,{maxAgeSec=24*3600,now=Date.now()}={}){
  if(!initData||!botToken)return {ok:false,reason:"missing"};
  let params;
  try{params=new URLSearchParams(String(initData))}catch{return {ok:false,reason:"malformed"}}
  const hash=params.get("hash");
  if(!hash||!/^[0-9a-f]{64}$/i.test(hash))return {ok:false,reason:"no_hash"};
  params.delete("hash");
  const dataCheck=[...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join("\n");
  const secret=createHmac("sha256","WebAppData").update(botToken).digest();
  const expected=createHmac("sha256",secret).update(dataCheck).digest("hex");
  const a=Buffer.from(expected,"hex"),b=Buffer.from(hash.toLowerCase(),"hex");
  if(a.length!==b.length||!timingSafeEqual(a,b))return {ok:false,reason:"bad_signature"};
  const authDate=Number(params.get("auth_date")||0);
  if(!authDate||now/1000-authDate>maxAgeSec)return {ok:false,reason:"expired"};
  let user=null;
  try{user=params.get("user")?JSON.parse(params.get("user")):null}catch{user=null}
  return {ok:true,user,authDate};
}

// Для тестов и отладки: собрать подписанный initData так же, как это делает Telegram.
export function signInitData(fields,botToken){
  const params=new URLSearchParams();
  for(const [k,v] of Object.entries(fields))params.set(k,typeof v==="string"?v:JSON.stringify(v));
  const dataCheck=[...params.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join("\n");
  const secret=createHmac("sha256","WebAppData").update(botToken).digest();
  params.set("hash",createHmac("sha256",secret).update(dataCheck).digest("hex"));
  return params.toString();
}

// Скользящее окно: не больше `limit` событий за `windowMs` на ключ (id пользователя или IP).
export function createRateLimiter({limit=30,windowMs=10*60*1000}={}){
  const hits=new Map();
  return {
    check(key,now=Date.now()){
      const arr=(hits.get(key)||[]).filter(t=>now-t<windowMs);
      if(arr.length>=limit){hits.set(key,arr);return {ok:false,retryAfterSec:Math.ceil((arr[0]+windowMs-now)/1000)}}
      arr.push(now);hits.set(key,arr);return {ok:true,remaining:limit-arr.length};
    },
    sweep(now=Date.now()){for(const [k,arr] of hits){const a=arr.filter(t=>now-t<windowMs);if(a.length)hits.set(k,a);else hits.delete(k)}}
  };
}
