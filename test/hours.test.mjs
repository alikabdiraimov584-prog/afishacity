import test from "node:test";
import assert from "node:assert/strict";
import {parseHours,parseSchedule} from "../hours.mjs";

// 20.09.2026 — воскресенье; 21.09 — понедельник; 18.09 — пятница; 19.09 — суббота (Москва, +03:00).
const at=s=>`2026-09-${s}+03:00`;
const SUN_2130=at("20T21:30:00"),MON_0100=at("21T01:00:00"),MON_0300=at("21T03:00:00"),SAT_0300=at("19T03:00:00"),FRI_0300=at("18T03:00:00");
const cases=[
  ["Mo-Su 12:00-02:00",SUN_2130,{open_now:true,closes_at:"02:00",opens_at:null}],
  ["Mo-Su 12:00-02:00",MON_0100,{open_now:true,closes_at:"02:00",opens_at:null},"ночной интервал после полуночи"],
  ["Mo-Su 12:00-02:00",MON_0300,{open_now:false,closes_at:null,opens_at:"12:00"}],
  ["Mo-Th 12:00-00:00; Fr-Sa 12:00-06:00",SAT_0300,{open_now:true,closes_at:"06:00",opens_at:null},"ночь пятница→суббота"],
  ["Mo-Th 12:00-00:00; Fr-Sa 12:00-06:00",FRI_0300,{open_now:false,closes_at:null,opens_at:"12:00"},"четверг закрывается в 00:00"],
  ["Mo-Th 12:00-00:00; Fr-Sa 12:00-06:00",at("20T03:00:00"),{open_now:true,closes_at:"06:00",opens_at:null},"ночь суббота→воскресенье"],
  ["24/7",SUN_2130,{open_now:true,closes_at:null,opens_at:null}],
  ["Mo-Fr 10:00-22:00; Sa,Su 11:00-23:00",SUN_2130,{open_now:true,closes_at:"23:00",opens_at:null}],
  ["Mo-Fr 10:00-22:00; Sa,Su 11:00-23:00",at("21T09:00:00"),{open_now:false,closes_at:null,opens_at:"10:00"}],
  ["Mo-Fr 10:00-22:00; Sa,Su 11:00-23:00",at("21T22:30:00"),{open_now:false,closes_at:null,opens_at:"10:00"},"следующее открытие — завтра"],
  ["пн–вс 12:00–02:00",MON_0100,{open_now:true,closes_at:"02:00",opens_at:null},"русские дни и длинные тире"],
  ["ежедневно 10:00–22:00",SUN_2130,{open_now:true,closes_at:"22:00",opens_at:null}],
  ["круглосуточно",SUN_2130,{open_now:true,closes_at:null,opens_at:null}],
  ["пн-чт 12:00-00:00, пт-сб 12:00-06:00",SAT_0300,{open_now:true,closes_at:"06:00",opens_at:null},"запятая как разделитель правил"],
  ["ежедневно с 10:00 до 22:00",at("20T12:00:00"),{open_now:true,closes_at:"22:00",opens_at:null}],
  ["Mo-Fr 10:00-19:00; Sa,Su off",SUN_2130,{open_now:false,closes_at:null,opens_at:"10:00"},"выходные off"],
  ["Mo-Su 10:00-22:00; PH off",SUN_2130,{open_now:true,closes_at:"22:00",opens_at:null},"PH игнорируется"],
  ["до 02:00",SUN_2130,{open_now:null,closes_at:null,opens_at:null},"непонятная строка → null"],
  ["часы работы на сайте",SUN_2130,{open_now:null,closes_at:null,opens_at:null}],
  ["",SUN_2130,{open_now:null,closes_at:null,opens_at:null}],
];
for(const [text,now,expected,label] of cases){
  test(`parseHours(${JSON.stringify(text)}) @ ${now.slice(0,16)}${label?" — "+label:""}`,()=>{
    assert.deepEqual(parseHours(text,now),expected);
  });
}

test("parseSchedule: расписание по дням, позднее правило переопределяет раннее", ()=>{
  const w=parseSchedule("Mo-Su 10:00-22:00; Su off");
  assert.deepEqual(w[0],[{start:600,end:1320}]);
  assert.deepEqual(w[6],[]);
  assert.equal(parseSchedule("цены на сайте"),null);
});

test("parseHours принимает Date и невалидную дату не роняет", ()=>{
  assert.equal(parseHours("24/7",new Date(SUN_2130)).open_now,true);
  assert.equal(parseHours("24/7","not a date").open_now,null);
});
