import test from "node:test";
import assert from "node:assert/strict";
import {buildPlan,parseStops,travel,planSummary} from "../planner.mjs";

const place=(id,name,extra={})=>({id,name,category:"Бар",kind:"venue",area:"Москва",coords:{lat:55.76,lon:37.60},price_min:null,...extra});
const searchBy=(map)=>async(args)=>{const key=Object.keys(map).find(k=>args.query.includes(k));return {results:key?map[key]:[]}};

test("парсинг фразы на остановки", ()=>{
  assert.deepEqual(parseStops("хочу поужинать, потом в бар, а после кальян").map(s=>s.query),["ужин ресторан","бар","кальянная"]);
  assert.deepEqual(parseStops("выставка и потом кофе").map(s=>s.query),["выставка","кофейня"]);
  assert.deepEqual(parseStops("просто бар"),[]);
});

test("переходы: пешком до ~2 км, дальше такси, без координат — оценка", ()=>{
  assert.equal(travel({lat:55.76,lon:37.60},{lat:55.765,lon:37.61}).mode,"walk");
  assert.equal(travel({lat:55.76,lon:37.60},{lat:55.70,lon:37.75}).mode,"taxi");
  assert.equal(travel(null,{lat:1,lon:1}).mode,"unknown");
});

test("план из трёх точек: время идёт последовательно, следующая точка ищется рядом с предыдущей", async ()=>{
  const seen=[];
  const search=async(args)=>{seen.push(args);
    if(args.query.includes("ужин"))return {results:[place("r","Ресторан",{category:"Ресторан",price_min:2500,coords:{lat:55.760,lon:37.600}})]};
    if(args.query.includes("бар"))return {results:[place("b1","Бар А",{coords:{lat:55.763,lon:37.606}}),place("b2","Бар Б")]};
    if(args.query.includes("кальян"))return {results:[place("h","Кальянная",{category:"Кальянная",coords:{lat:55.72,lon:37.65}})]};
    return {results:[]}};
  const plan=await buildPlan({stops:[{query:"ужин ресторан"},{query:"бар"},{query:"кальянная"}],start_time:"19:00",party_size:2},search);
  assert.equal(plan.status,"ok");
  assert.equal(plan.stops[0].slot_start,"19:00");assert.equal(plan.stops[0].slot_end,"20:30");
  assert.equal(plan.stops[1].travel_in.mode,"walk");
  assert.ok(plan.stops[1].slot_start>="20:33");
  assert.equal(plan.stops[2].travel_in.mode,"taxi");
  assert.equal(plan.stops[1].alternatives[0].id,"b2");
  assert.equal(seen[1].user_location.lat,55.760,"второй поиск привязан к первой точке");
  assert.match(seen[1].query,/рядом/);
  assert.equal(seen[1].after_time,"20:30");
  assert.equal(plan.total.price_from,2500);
  assert.match(plan.route_url,/yandex\.ru\/maps/);
  assert.match(planSummary(plan),/19:00–20:30 Ресторан/);
});

test("событие прибивает время к сеансу и сдвигает дальнейшие точки", async ()=>{
  const search=async(args)=>args.query.includes("стендап")
    ?{results:[place("e","Стендап",{kind:"event",category:"Стендап",times:["19:30","22:00"],coords:{lat:55.76,lon:37.60}})]}
    :{results:[place("b","Бар")]};
  const plan=await buildPlan({stops:[{query:"стендап"},{query:"бар"}],start_time:"20:00"},search);
  assert.equal(plan.stops[0].slot_start,"22:00");
  assert.equal(plan.stops[0].slot_end,"00:00");
  assert.equal(plan.stops[0].conflict,false);
  const late=await buildPlan({stops:[{query:"стендап"}],start_time:"23:00"},search);
  assert.equal(late.stops[0].conflict,true);
});

test("ненайденная остановка помечается, план частичный", async ()=>{
  const plan=await buildPlan({stops:[{query:"бар"},{query:"единороги"}],start_time:"20:00"},searchBy({"бар":[place("b","Бар")]}));
  assert.equal(plan.status,"partial");assert.equal(plan.stops[1].missing,true);assert.equal(plan.total.found,1);
});

test("заранее выбранное место используется без поиска", async ()=>{
  let calls=0;
  const plan=await buildPlan({stops:[{query:"ужин",place:place("x","Мой ресторан",{coords:{lat:55.75,lon:37.62}})},{query:"бар"}],start_time:"19:00"},async()=>{calls++;return {results:[place("b","Бар",{coords:{lat:55.752,lon:37.623}})]}});
  assert.equal(calls,1);assert.equal(plan.stops[0].place.name,"Мой ресторан");assert.equal(plan.stops[1].travel_in.mode,"walk");
});

test("план не собирается из случайного «потом» без узнаваемых активностей", ()=>{
  assert.deepEqual(parseStops("поесть и потом домой"),[]);
  assert.deepEqual(parseStops("после работы хочу выпить"),[]);
  assert.equal(parseStops("сначала кофе, потом выставка").length,2);
});
