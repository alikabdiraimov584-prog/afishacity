// Разбор полей, приходящих из внешних источников. Ошибки здесь не видны в логах:
// они превращаются в неверную цену и неверную дату на карточке.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const src=readFileSync(new URL("../providers.mjs",import.meta.url),"utf8");
const parseMoney=new Function(src.slice(src.indexOf("const MONEY_UNIT"),src.indexOf("function isoDate"))+"; return parseMoney")();
const isoDate=new Function(src.slice(src.indexOf("const MSK_DATE"),src.indexOf("function hhmm"))+"; return isoDate")();

test("ценой считается только сумма рядом с денежным признаком", () => {
  const cases=[["от 500 рублей",500],["1500 р",1500],["от 1 000 ₽",1000],["Стоимость: 1 200 руб.",1200],
    ["цена 300",300],["от 2500",2500],["250-800 руб",250],["16+, от 800 ₽",800]];
  for(const [s,want] of cases)assert.equal(parseMoney(s),want,s);
});

test("возраст, время и год ценой не становятся", () => {
  // «18+» превращалось в цену 18 ₽ и проходило любой фильтр бюджета.
  for(const s of ["18+","вход свободный, 21+","с 12:00 до 23:00","2026 год","бесплатно","",null])
    assert.equal(parseMoney(s),null,String(s));
});

test("дата события считается по московскому времени", () => {
  // Сеанс в 00:30 МСК получал вчерашнюю дату и пропадал из фильтра «сегодня».
  assert.equal(isoDate("2026-09-21T00:30:00+03:00"),"2026-09-21");
  assert.equal(isoDate("2026-09-21T02:30:00+03:00"),"2026-09-21");
  assert.equal(isoDate("2026-09-20T23:59:00+03:00"),"2026-09-20");
  assert.equal(isoDate(null),null);
  assert.equal(isoDate("мусор"),null);
});

test("клиентский таймаут не меньше того, что мы просим у Overpass", () => {
  const asked=Number(/const OVERPASS_TIMEOUT_S=(\d+)/.exec(src)[1]);
  const passed=Number(/timeoutMs:\(OVERPASS_TIMEOUT_S\+(\d+)\)\*1000/.exec(src)[1]);
  assert.ok(passed>0,"клиент обрывал запрос раньше, чем Overpass обязан ответить");
  assert.ok(asked+passed<=20,"суммарное ожидание не должно превышать 20 с");
});
