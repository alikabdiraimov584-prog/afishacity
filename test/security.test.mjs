import test from "node:test";
import assert from "node:assert/strict";
import {openStore} from "../store.mjs";

test("чужой X-Free-Client не даёт доступ к аккаунту Telegram", () => {
  const s=openStore(":memory:");
  const victim=s.user({tg_id:1001,anon_id:"victim-anon-id-0001",first_name:"Жертва"});
  s.updateProfile(victim.id,{saved:[{id:"a",name:"Личное место"}]});
  // Первый вход злоумышленника со своим Telegram, но с подставленным чужим клиентом.
  const attacker=s.user({tg_id:2002,anon_id:"victim-anon-id-0001",first_name:"Чужой"});
  assert.notEqual(attacker.id,victim.id,"аккаунт захвачен");
  assert.deepEqual(s.getProfile(attacker.id).saved,[],"чужое сохранённое видно");
  assert.equal(s.user({tg_id:1001}).id,victim.id,"владелец потерял свой аккаунт");
  assert.deepEqual(s.getProfile(victim.id).saved,[{id:"a",name:"Личное место"}]);
});

test("штатная привязка анонимной истории к Telegram работает", () => {
  const s=openStore(":memory:");
  const anon=s.user({anon_id:"fresh-anon-000000001"});
  s.updateProfile(anon.id,{saved:[{id:"b",name:"Моё"}]});
  const linked=s.user({tg_id:3003,anon_id:"fresh-anon-000000001"});
  assert.equal(linked.id,anon.id,"история не перенеслась");
  assert.deepEqual(s.getProfile(linked.id).saved,[{id:"b",name:"Моё"}]);
  assert.equal(s.user({tg_id:3003,anon_id:"fresh-anon-000000001"}).id,anon.id,"повторный вход");
});

test("занятый анонимный идентификатор не роняет запрос", () => {
  const s=openStore(":memory:");
  s.user({tg_id:1,anon_id:"taken-anon-00000001"});
  // Раньше здесь падало на уникальном индексе users.anon_id.
  const other=s.user({tg_id:2,anon_id:"taken-anon-00000001"});
  assert.ok(other&&other.id,"запрос завершился ошибкой");
  assert.equal(other.anon_id,null,"чужой идентификатор присвоен");
});

test("ссылка с опасной схемой не попадает на страницу плана", async () => {
  const {readFileSync}=await import("node:fs");
  const src=readFileSync(new URL("../server.mjs",import.meta.url),"utf8");
  const m=src.match(/function safeHref\(raw\)\{[\s\S]*?\n\}/);
  assert.ok(m,"safeHref не найдена");
  const safeHref=new Function("return "+m[0])();
  for(const bad of ["javascript:alert(1)","JaVaScRiPt:alert(1)","data:text/html,<script>","vbscript:x","//evil.com","",null])
    assert.equal(safeHref(bad),"",String(bad));
  for(const good of ["https://example.com/x","http://example.com","tel:+79990000000","mailto:a@b.c","/p/abc"])
    assert.equal(safeHref(good),good,good);
});

test("ссылка из тегов OpenStreetMap проверяется по схеме", async () => {
  const {readFileSync}=await import("node:fs");
  const src=readFileSync(new URL("../providers.mjs",import.meta.url),"utf8");
  const m=src.match(/function safeLink\(raw\)\{[\s\S]*?\n\}/);
  assert.ok(m,"safeLink не найдена");
  const safeLink=new Function("return "+m[0])();
  for(const bad of ["javascript:alert(1)","data:text/html,x","ftp://a/b","мусор",""])
    assert.equal(safeLink(bad),null,String(bad));
  assert.equal(safeLink("https://rovesnik.bar/"),"https://rovesnik.bar/");
});
