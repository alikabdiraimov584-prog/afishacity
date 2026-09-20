import test from "node:test";
import assert from "node:assert/strict";
import {verifyInitData,signInitData,createRateLimiter} from "../telegram.mjs";

const TOKEN="123456:TESTTOKEN";
const now=1_800_000_000_000;
const fields=()=>({auth_date:String(Math.floor(now/1000)-60),query_id:"AAH",user:{id:42,first_name:"Дима",language_code:"ru"}});

test("валидная подпись принимается, пользователь разобран", ()=>{
  const v=verifyInitData(signInitData(fields(),TOKEN),TOKEN,{now});
  assert.equal(v.ok,true);assert.equal(v.user.id,42);
});
test("подделанные данные и чужой токен отклоняются", ()=>{
  const good=signInitData(fields(),TOKEN);
  assert.equal(verifyInitData(good.replace("42","43"),TOKEN,{now}).ok,false);
  assert.equal(verifyInitData(good,"other:token",{now}).reason,"bad_signature");
  assert.equal(verifyInitData("","x").reason,"missing");
  assert.equal(verifyInitData("user=1",TOKEN).reason,"no_hash");
});
test("устаревший auth_date отклоняется", ()=>{
  const v=verifyInitData(signInitData({...fields(),auth_date:String(Math.floor(now/1000)-2*86400)},TOKEN),TOKEN,{now});
  assert.equal(v.reason,"expired");
});
test("лимит запросов: скользящее окно", ()=>{
  const rl=createRateLimiter({limit:3,windowMs:1000});
  assert.equal(rl.check("u",0).ok,true);assert.equal(rl.check("u",10).ok,true);assert.equal(rl.check("u",20).ok,true);
  const blocked=rl.check("u",30);assert.equal(blocked.ok,false);assert.equal(blocked.retryAfterSec,1);
  assert.equal(rl.check("other",30).ok,true);
  assert.equal(rl.check("u",1001).ok,true);
});
