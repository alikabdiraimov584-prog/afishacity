import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV="test";
process.env.ANTHROPIC_API_KEY="test-key";
const {runDialogue,conversationTrim,setDialogueClient,recommendTool}=await import("../server.mjs");

// Мок Claude: первый ход — вызов инструмента, второй — текстовый ответ по результатам.
function mockClient(script){
  const calls=[];
  return {calls,beta:{messages:{create:async(req)=>{calls.push(req);const step=script[Math.min(calls.length-1,script.length-1)];return step(req)}}}};
}
const toolTurn=(input)=>()=>({model:"claude-opus-5",stop_reason:"tool_use",content:[{type:"text",text:"Сейчас посмотрю."},{type:"tool_use",id:"tu_1",name:"recommend_free",input}]});
const textTurn=(text)=>(req)=>{
  const last=req.messages.at(-1);
  assert.equal(last.role,"user");
  assert.equal(last.content[0].type,"tool_result");
  assert.equal(last.content[0].tool_use_id,"tu_1");
  return {model:"claude-opus-5",stop_reason:"end_turn",content:[{type:"text",text}]};
};

test("цикл инструмента: tool_use → recommend → ответ, история сохраняется по id", async ()=>{
  const client=mockClient([toolTurn({query:"стендап сегодня"}),textTurn("Вот два варианта на вечер.")]);
  setDialogueClient(client);
  const r=await runDialogue("хочу на стендап",null,{taste_weights:{quiet:1}});
  assert.equal(r.reply,"Вот два варианта на вечер.");
  assert.equal(r.tool_used,true);
  assert.ok(r.response_id);
  assert.equal(client.calls.length,2);
  const first=client.calls[0];
  assert.equal(first.model,"claude-opus-5");
  assert.equal(first.tools[0].name,"recommend_free");
  assert.equal(first.tool_choice.type,"auto");
  assert.equal(first.fallbacks,"default");
  assert.ok(first.system[0].cache_control,"стабильный системный промпт кешируется");
  assert.match(first.system[1].text,/"quiet":1/);

  // Второй ход продолжает ту же историю.
  const client2=mockClient([(req)=>{
    assert.equal(req.messages[0].content,"хочу на стендап");
    assert.equal(req.messages.at(-1).content,"а подешевле?");
    return {model:"claude-opus-5",stop_reason:"end_turn",content:[{type:"text",text:"Есть бесплатный вариант."}]};
  }]);
  setDialogueClient(client2);
  const r2=await runDialogue("а подешевле?",r.response_id,{});
  assert.equal(r2.reply,"Есть бесплатный вариант.");
  assert.equal(r2.response_id,r.response_id);
  assert.equal(r2.tool_used,false);
});

test("неизвестный id диалога начинает новую историю", async ()=>{
  const client=mockClient([(req)=>{assert.equal(req.messages.length,1);return {model:"m",stop_reason:"end_turn",content:[{type:"text",text:"ок"}]}}]);
  setDialogueClient(client);
  const r=await runDialogue("привет","nope",{});
  assert.notEqual(r.response_id,"nope");
});

test("refusal и пустой ответ дают безопасный текст", async ()=>{
  setDialogueClient(mockClient([()=>({model:"m",stop_reason:"refusal",content:[]})]));
  const r=await runDialogue("...",null,{});
  assert.match(r.reply,/помочь не смогу/);
  setDialogueClient(mockClient([()=>({model:"m",stop_reason:"end_turn",content:[]})]));
  const r2=await runDialogue("...",null,{});
  assert.match(r2.reply,/подробнее/);
});

test("история режется только по границе реплики пользователя", ()=>{
  const m=[];
  for(let i=0;i<30;i++){
    m.push({role:"user",content:"q"+i});
    m.push({role:"assistant",content:[{type:"tool_use",id:"t"+i}]});
    m.push({role:"user",content:[{type:"tool_result",tool_use_id:"t"+i}]});
    m.push({role:"assistant",content:[{type:"text",text:"a"}]});
  }
  const t=conversationTrim(m);
  assert.ok(t.length<=40);
  assert.equal(typeof t[0].content,"string");
  assert.equal(t[0].role,"user");
});

test("схема инструмента валидна", ()=>{
  assert.equal(recommendTool.input_schema.type,"object");
  assert.deepEqual(recommendTool.input_schema.required,["query"]);
});

test("plan_evening: план возвращается в ответе, модель получает сводку", async ()=>{
  const {sharePlan,sharedPlanPage}=await import("../server.mjs");
  const client=mockClient([
    ()=>({model:"m",stop_reason:"tool_use",content:[{type:"tool_use",id:"tu_p",name:"plan_evening",input:{stops:[{query:"ужин"},{query:"бар"}],start_time:"19:00"}}]}),
    (req)=>{const tr=req.messages.at(-1).content[0];assert.equal(tr.tool_use_id,"tu_p");const parsed=JSON.parse(tr.content);assert.ok("summary" in parsed);assert.equal(parsed.stops.length,2);
      return {model:"m",stop_reason:"end_turn",content:[{type:"text",text:"План готов."}]}}
  ]);
  setDialogueClient(client);
  const r=await runDialogue("поужинать и потом в бар",null,{});
  assert.equal(r.reply,"План готов.");
  assert.ok(r.plan&&Array.isArray(r.plan.stops)&&r.plan.stops.length===2);
  assert.equal(r.plan.stops[0].slot_start,"19:00");
  // Поделиться: страница рендерится и экранирует HTML
  const fake={status:"ok",stops:[{index:1,query:"бар",slot_start:"19:00",slot_end:"20:30",place:{name:"<b>Бар</b>",category:"Бар",area:"Москва",source:"https://x"},travel_to_next:{mode:"walk",minutes:7,km:0.5}},{index:2,query:"кальян",slot_start:"20:40",slot_end:"22:40",place:null}],total:{start:"19:00",end:"22:40",travel_km:0.5},route_url:"https://yandex.ru/maps/?x"};
  const id=sharePlan(fake,{title:"Тест"});
  assert.match(id,/^[a-f0-9]{10}$/);
  const html=sharedPlanPage({id,title:"Тест",plan:fake});
  assert.ok(html.includes("&lt;b&gt;Бар&lt;/b&gt;"));
  assert.ok(html.includes("пешком ~7 мин"));
  assert.ok(html.includes("кальян — не найдено"));
});

test("стриминг: дельты, статус инструмента и done по SSE", async ()=>{
  const {server}=await import("../server.mjs");
  // Мок с .stream(): отдаёт текст кусками, потом финальное сообщение.
  let n=0;
  const streamClient={beta:{messages:{
    stream:(req)=>{
      n++;
      const handlers={};
      const final=n===1
        ?{model:"m",stop_reason:"tool_use",content:[{type:"text",text:"Сейчас посмотрю."},{type:"tool_use",id:"tu_s",name:"recommend_free",input:{query:"джаз бар"}}]}
        :{model:"m",stop_reason:"end_turn",content:[{type:"text",text:"Вот два бара."}]};
      return {on(ev,cb){handlers[ev]=cb;return this},async finalMessage(){const t=final.content.find(b=>b.type==="text")?.text||"";for(const ch of t.match(/.{1,5}/g)||[])handlers.text?.(ch);return final}};
    }
  }}};
  setDialogueClient(streamClient);
  // Без emit — обычный путь, но клиент без create: проверяем только стриминговый путь через HTTP.
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const port=server.address().port;
  try{
  const resp=await fetch(`http://127.0.0.1:${port}/api/dialogue/stream`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:"джаз бар"})});
  assert.equal(resp.headers.get("content-type"),"text/event-stream; charset=utf-8");
  const raw=await resp.text();
  const events=raw.split("\n\n").filter(x=>x.startsWith("event:")).map(x=>{const [e,d]=x.split("\n");return {type:e.slice(7),data:JSON.parse(d.slice(6))}});
  const types=events.map(e=>e.type);
  assert.ok(types.includes("delta"));
  assert.ok(types.includes("status"));
  assert.ok(types.includes("break"));
  assert.equal(types.at(-1),"done");
  const deltas=events.filter(e=>e.type==="delta").map(e=>e.data.text).join("");
  assert.ok(deltas.includes("Сейчас посмотрю.")&&deltas.includes("Вот два бара."));
  assert.equal(events.find(e=>e.type==="status").data.text,"Ищу: джаз бар");
  const done=events.at(-1).data;
  assert.equal(done.reply,"Вот два бара.");assert.equal(done.reply_streamed,true);assert.ok(done.response_id);
  }finally{await new Promise(r=>server.close(r))}
});
