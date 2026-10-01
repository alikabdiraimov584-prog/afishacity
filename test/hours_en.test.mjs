// Английские часы работы (Foursquare, Google): дни недели, 12-часовое время,
// noon/midnight, «closed», «open 24 hours». Формат ответа — тот же.
import test from "node:test";
import assert from "node:assert/strict";
import {parseHours,parseSchedule} from "../hours.mjs";
import {CITY} from "../city.mjs";

// Моменты заданы в местном времени города, чтобы тесты шли и при CITY=dubai.
// 20.09.2026 — воскресенье, 21.09 — понедельник, 18.09 — пятница, 19.09 — суббота.
const at=s=>`2026-09-${s}${CITY.utcOffset}`;
const H=(a,b)=>[{start:a,end:b}];

test("parseSchedule: английские дни и 12-часовое время", () => {
  const w=parseSchedule("Mon-Thu 6pm–2am; Fri,Sat 6pm-4am");
  assert.deepEqual(w[0],H(1080,1560));assert.deepEqual(w[3],H(1080,1560));
  assert.deepEqual(w[4],H(1080,1680));assert.deepEqual(w[5],H(1080,1680));
  assert.deepEqual(w[6],[],"воскресенье не упомянуто — закрыто");
  assert.deepEqual(parseSchedule("6:30 PM - 1 AM")[2],H(1110,1500));
  assert.deepEqual(parseSchedule("daily noon-midnight")[6],H(720,1440));
  assert.deepEqual(parseSchedule("Mon-Thu 12:00-00:00; Fri,Sat 12:00-03:00")[5],H(720,1620));
  assert.deepEqual(parseSchedule("weekdays 10am - 10pm; weekends closed")[0],H(600,1320));
  assert.deepEqual(parseSchedule("weekdays 10am - 10pm; weekends closed")[6],[]);
  assert.deepEqual(parseSchedule("10:00 AM to 11:30 PM")[0],H(600,1410));
  assert.deepEqual(parseSchedule("12 am - 12 pm")[0],H(0,720),"12 am — полночь, 12 pm — полдень");
});

test("parseSchedule: формат Google «Monday: 12:00 PM – 2:00 AM» и «Open 24 hours»", () => {
  const w=parseSchedule("Monday: 12:00 PM – 2:00 AM; Tuesday: Closed; Wednesday: Open 24 hours; Sunday: 9:00 AM – 5:00 PM");
  assert.deepEqual(w[0],H(720,1560));assert.deepEqual(w[1],[]);assert.deepEqual(w[2],H(0,1440));assert.deepEqual(w[6],H(540,1020));
  assert.deepEqual(w[3],[],"четверг не упомянут — закрыто");
  const all=parseSchedule("Open 24 hours");
  assert.ok(all.every(d=>d.length===1&&d[0].start===0&&d[0].end===1440));
  assert.ok(parseSchedule("Sunday: Closed").every((d,i)=>i===6?d.length===0:d.length===0));
});

test("parseHours по английской строке: ночной интервал и ближайшее открытие", () => {
  const s="Mon-Thu 6pm–2am; Fri,Sat 6pm-4am";
  assert.deepEqual(parseHours(s,at("18T21:30:00")),{open_now:true,closes_at:"04:00",opens_at:null},"пятница вечером");
  assert.deepEqual(parseHours(s,at("19T03:00:00")),{open_now:true,closes_at:"04:00",opens_at:null},"ночь пятница→суббота");
  assert.deepEqual(parseHours(s,at("20T21:30:00")),{open_now:false,closes_at:null,opens_at:"18:00"},"воскресенье закрыто, откроется в понедельник");
  assert.deepEqual(parseHours("Open 24 hours",at("20T21:30:00")),{open_now:true,closes_at:null,opens_at:null});
  assert.deepEqual(parseHours("Call for hours",at("20T21:30:00")),{open_now:null,closes_at:null,opens_at:null},"непонятная строка → null");
});
