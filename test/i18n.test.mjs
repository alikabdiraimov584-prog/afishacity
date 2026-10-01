// Словарь интерфейса (public/index.html): русский и английский наборы должны
// совпадать по ключам, а каждый data-i18n в разметке — указывать на
// существующий ключ. Иначе на одном из языков человек увидит имя ключа.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const SRC=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");

function dict(){
  const at=SRC.indexOf("const I18N={");
  const end=SRC.indexOf("\n}};",at);
  assert.ok(at>0&&end>at,"словарь I18N не найден");
  const code=SRC.slice(at,end+4)+"\nI18N";
  return vm.runInNewContext(code,{});
}

test("ru и en словари совпадают по ключам", () => {
  const I18N=dict();
  const ru=Object.keys(I18N.ru),en=new Set(Object.keys(I18N.en));
  const missing=ru.filter(k=>!en.has(k));
  const extra=[...en].filter(k=>!I18N.ru[k]);
  assert.deepEqual(missing,[],"нет в en: "+missing.join(", "));
  assert.deepEqual(extra,[],"нет в ru: "+extra.join(", "));
  for(const k of ru){
    assert.equal(typeof I18N.ru[k],typeof I18N.en[k],`тип значения «${k}» различается`);
    if(Array.isArray(I18N.ru[k]))assert.equal(I18N.ru[k].length,I18N.en[k].length,`число вариантов «${k}» различается`);
  }
});

test("английские тексты не содержат кириллицы, русские — без ключей-заглушек", () => {
  const I18N=dict();
  const bad=Object.entries(I18N.en).filter(([,v])=>/[а-яё]/i.test(JSON.stringify(v))).map(([k])=>k);
  assert.deepEqual(bad,[],"кириллица в en: "+bad.join(", "));
  assert.equal(I18N.en["intro.eyebrow"],"DON'T SEARCH. JUST ASK.");
  assert.equal(I18N.ru["intro.eyebrow"],"НЕ ИЩИТЕ. РАЗГОВАРИВАЙТЕ.");
  assert.equal(I18N.en["card.best"],"BEST MATCH");
  assert.equal(I18N.en["card.plan"],"Add to plan");
});

test("каждый data-i18n в разметке ссылается на ключ словаря", () => {
  const I18N=dict();
  const keys=new Set(Object.keys(I18N.ru));
  const refs=[...SRC.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)].map(m=>m[1]);
  assert.ok(refs.length>=20,"разметка должна быть размечена data-i18n");
  const unknown=refs.filter(k=>!keys.has(k));
  assert.deepEqual(unknown,[],"неизвестные ключи: "+unknown.join(", "));
  // И статические вызовы t("…") тоже.
  const calls=[...SRC.matchAll(/\bt\("([a-zA-Z0-9_.-]+)"[,)]/g)].map(m=>m[1]);
  const unknownCalls=[...new Set(calls.filter(k=>!keys.has(k)))];
  assert.deepEqual(unknownCalls,[],"t() с неизвестным ключом: "+unknownCalls.join(", "));
});

test("t() подставляет переменные и город", () => {
  const at=SRC.indexOf("const I18N={");
  const end=SRC.indexOf("\napplyI18n();\n",at);
  const code=SRC.slice(at,end);
  const ctx={localStorage:{getItem:()=>null,setItem(){}},window:{},document:{documentElement:{lang:"ru"},title:"",querySelectorAll:()=>[]}};
  vm.runInNewContext(code+"\nglobalThis.__t=t;globalThis.__setCity=setCity;globalThis.__lang=()=>LANG;",ctx);
  assert.equal(ctx.__t("status.fallback"),"Резервный режим · Москва");
  assert.equal(ctx.__t("profile.synced",{n:3,e:2}),"Профиль синхронизирован · вкус обучен на 3 действиях · вечеров: 2");
  assert.equal(ctx.__t("nope.key"),"nope.key");
  assert.equal(ctx.__setCity({id:"dubai",name:"Dubai",nameEn:"Dubai",lang:"en",currencySymbol:"AED",agent:{lang:"en-US"}}),true);
  assert.equal(ctx.__lang(),"en");
  assert.equal(ctx.__t("status.fallback"),"Fallback mode · Dubai");
  assert.equal(ctx.__t("detail.openTill",{t:"1:00"}),"Open · till 1:00");
  assert.equal(ctx.__t("agent.role"),"your Dubai concierge");
  assert.equal(ctx.document.documentElement.lang,"en");
});
