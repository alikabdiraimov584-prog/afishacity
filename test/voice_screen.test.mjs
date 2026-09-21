// Экран разговора целиком, без браузера.
//
// Скрипт экрана — обычная IIFE, принимающая глобальный объект, поэтому его
// можно запустить в песочнице с заглушками вместо DOM и звука. Проверять
// вырезанные куски исходника через new Function бессмысленно: так тестируется
// копия, и любая ссылка на соседнюю функцию ломает тест, а не находит ошибку.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const SRC=readFileSync(new URL("../public/voice.js",import.meta.url),"utf8");

/** Узел, которому хватает того, что скрипт экрана от него хочет. */
function node(){
  const classes=new Set();
  return {textContent:"",innerHTML:"",dataset:{},style:{},
    classList:{add:(c)=>classes.add(c),remove:(c)=>classes.delete(c),contains:(c)=>classes.has(c)},
    setAttribute(){},getAttribute(){return null},appendChild(){},addEventListener(){}};
}

/** Поток server-sent events из готового списка событий. */
function sse(events){
  const text=events.map(([type,data])=>`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const bytes=new TextEncoder().encode(text);
  let sent=false;
  return {getReader:()=>({read:async()=>sent?{done:true}:(sent=true,{value:bytes,done:false})})};
}

function screen({events,tts=true}={}){
  const nodes={};
  for(const id of ["#voiceScreen","#voiceHint","#voiceHeard","#voiceSaid","#voiceCards"])nodes[id]=node();
  const spoken=[];
  const sandbox={
    document:{querySelector:(s)=>nodes[s]||null,body:{style:{}}},
    window:{},
    setTimeout,clearTimeout,TextDecoder,TextEncoder,console,
    requestAnimationFrame:()=>0,cancelAnimationFrame(){},
    URL:{createObjectURL:()=>"blob:x",revokeObjectURL(){}},
    Audio:function(){return {playsInline:false,addEventListener(_,f){if(_==="ended")setTimeout(f,0)},
      play:async()=>{},pause(){}}},
  };
  sandbox.globalThis=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC,sandbox);
  const cards=[];
  sandbox.FreeVoice.init({
    apiFetch:async(path)=>{
      if(path.startsWith("/api/voice/tts")){
        if(!tts)return {ok:false,status:502,json:async()=>({})};
        spoken.push(true);
        return {ok:true,status:200,blob:async()=>({})};
      }
      return {ok:true,status:200,body:sse(events),json:async()=>({})};
    },
    context:()=>({}),
    renderCards:(list)=>cards.push(...list),
  });
  return {api:sandbox.FreeVoice,nodes,cards,spoken};
}

test("ход заканчивается ожиданием, даже если говорить было нечего", async () => {
  // Жалоба «она не разговаривает и не показывает результат»: на экране висел
  // ответ, а подсказка так и осталась «Ищу». Всё, что пришло от сервера, было
  // помечено как промежуточное, очередь речи ни разу не запускалась — а из
  // «думаю» экран выводила именно она. Разговор замирал до перезагрузки.
  const s=screen({events:[
    ["delta",{text:"Ближе всего Ровесник",interim:true}],
    ["done",{response_id:"r1",results:[]}],
  ]});
  await s.api._ask("бар рядом");
  assert.equal(s.api.phase,"idle","экран не должен остаться в «думаю»");
  assert.equal(s.nodes["#voiceSaid"].textContent,"Ближе всего Ровесник");
});

test("произнесённый ответ и карточки доходят до экрана", async () => {
  const s=screen({events:[
    ["delta",{text:"Секунду",interim:true}],
    ["delta",{text:"Ближе всего Ровесник",interim:false}],
    ["done",{response_id:"r1",results:[{name:"Ровесник"}]}],
  ]});
  await s.api._ask("бар рядом");
  assert.equal(s.spoken.length,1,"произносится только ответ, не обещание");
  assert.deepEqual(s.cards.map(c=>c.name),["Ровесник"]);
  assert.equal(s.api.phase,"idle");
});

test("молчащий синтез не подвешивает экран", async () => {
  // Синтез отказал — текст на экране остаётся, но ход всё равно закончен.
  const s=screen({tts:false,events:[
    ["delta",{text:"Ближе всего Ровесник",interim:false}],
    ["done",{response_id:"r1",results:[]}],
  ]});
  await s.api._ask("бар");
  assert.equal(s.api.phase,"idle");
});
