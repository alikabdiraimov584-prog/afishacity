import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV="test";
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
