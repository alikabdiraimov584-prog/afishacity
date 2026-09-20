import test from "node:test";
import assert from "node:assert/strict";
import {isPrivateAddress,safeRemoteUrl,resolvesPublic,guardedFetch} from "../net_guard.mjs";

test("приватные и служебные адреса распознаются", () => {
  for(const ip of ["127.0.0.1","127.0.0.2","127.1.2.3","10.0.0.5","192.168.1.1","172.16.0.1","172.31.255.255",
    "169.254.169.254","100.64.0.1","0.0.0.0","224.0.0.1","::1","::","::ffff:127.0.0.1","fc00::1","fd12::1","fe80::1"])
    assert.equal(isPrivateAddress(ip),true,ip);
  for(const ip of ["8.8.8.8","1.1.1.1","93.184.216.34","172.32.0.1","100.128.0.1","2606:4700::1111"])
    assert.equal(isPrivateAddress(ip),false,ip);
});

test("структурная проверка адреса закрывает обходные записи", () => {
  for(const u of ["http://127.0.0.1/","http://127.0.0.2/","http://[::1]/","http://localhost/","http://LOCALHOST./",
    "http://2130706433/","http://0177.0.0.1/","http://db.internal/","http://x.local/","file:///etc/passwd",
    "http://user:pass@evil.com@127.0.0.1/","http://169.254.169.254/latest/meta-data/"])
    assert.equal(safeRemoteUrl(u),null,u);
  for(const u of ["https://example.com/a.jpg","http://93.184.216.34/x"])
    assert.ok(safeRemoteUrl(u),u);
});

test("имя, резолвящееся в приватный адрес, не пропускается", async () => {
  const priv=async()=>[{address:"127.0.0.1",family:4}];
  const pub=async()=>[{address:"93.184.216.34",family:4}];
  const mixed=async()=>[{address:"93.184.216.34",family:4},{address:"10.0.0.1",family:4}];
  assert.equal(await resolvesPublic(new URL("https://rebind.example/"),{lookupImpl:priv}),false);
  assert.equal(await resolvesPublic(new URL("https://ok.example/"),{lookupImpl:pub}),true);
  assert.equal(await resolvesPublic(new URL("https://half.example/"),{lookupImpl:mixed}),false,"хватает одного приватного адреса");
  assert.equal(await resolvesPublic(new URL("https://broken.example/"),{lookupImpl:async()=>{throw new Error("NXDOMAIN")}}),false);
});

const pubLookup=async()=>[{address:"93.184.216.34",family:4}];
const resp=(o)=>({ok:true,status:200,url:o.url||"https://ok.example/",headers:new Headers(o.headers||{}),body:o.body});
const stream=(bufs)=>({async *[Symbol.asyncIterator](){for(const b of bufs)yield b}});

test("перенаправление во внутреннюю сеть не выполняется", async () => {
  const hops=[];
  const fetchImpl=async(u)=>{
    hops.push(String(u));
    if(String(u).includes("start"))return {ok:false,status:302,url:String(u),headers:new Headers({location:"http://169.254.169.254/latest/"}),body:null};
    return resp({body:stream([Buffer.from("x")])});
  };
  const r=await guardedFetch("https://start.example/",{fetchImpl,lookupImpl:pubLookup});
  assert.equal(r.ok,false);
  assert.equal(r.reason,"blocked_url");
  assert.equal(hops.length,1,"на внутренний адрес запроса не было");
});

test("тело обрывается на лимите, а не читается целиком", async () => {
  const big=Buffer.alloc(64*1024,0x61);
  const fetchImpl=async()=>resp({headers:{"content-type":"image/jpeg"},body:stream(Array.from({length:200},()=>big))});
  const r=await guardedFetch("https://ok.example/big.jpg",{fetchImpl,lookupImpl:pubLookup,maxBytes:256*1024});
  assert.equal(r.body.length,256*1024,"прочитано ровно до лимита");
  assert.equal(r.truncated,true);
});

test("заявленный размер больше лимита — тело не читается", async () => {
  let read=false;
  const fetchImpl=async()=>resp({headers:{"content-type":"image/jpeg","content-length":"99999999"},
    body:{async *[Symbol.asyncIterator](){read=true;yield Buffer.from("x")},cancel(){}}});
  const r=await guardedFetch("https://ok.example/huge.jpg",{fetchImpl,lookupImpl:pubLookup,maxBytes:1024});
  assert.equal(r.reason,"too_large");
  assert.equal(read,false);
});

test("тип содержимого проверяется до чтения", async () => {
  const fetchImpl=async()=>resp({headers:{"content-type":"text/html"},body:stream([Buffer.from("<html>")])});
  const r=await guardedFetch("https://ok.example/x",{fetchImpl,lookupImpl:pubLookup,accept:t=>t.startsWith("image/")});
  assert.equal(r.reason,"bad_type");
});

test("цепочка перенаправлений ограничена", async () => {
  const fetchImpl=async(u)=>({ok:false,status:302,url:String(u),headers:new Headers({location:"https://loop.example/next"}),body:null});
  const r=await guardedFetch("https://loop.example/start",{fetchImpl,lookupImpl:pubLookup,maxRedirects:2});
  assert.equal(r.reason,"too_many_redirects");
});
