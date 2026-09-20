import test from "node:test";
import assert from "node:assert/strict";
import {buildSearchPlan} from "../providers.mjs";

const plan=q=>buildSearchPlan({query:q});

test("распознаёт основные намерения", ()=>{
  assert.deepEqual(plan("хочу на стендап сегодня вечером").eventQueries,["стендап"]);
  assert.ok(plan("покурить кальян на Патриарших").tags.includes("hookah"));
  assert.ok(plan("джаз бар").tags.includes("jazz"));
  assert.ok(plan("джаз бар").tags.includes("bar"));
  assert.ok(plan("поесть суши").tags.includes("food"));
  assert.ok(plan("хочу на рок концерт").tags.includes("rock"));
  assert.ok(plan("куда сходить с детьми").tags.includes("family"));
  assert.ok(plan("сходить в баню").tags.includes("spa"));
  assert.ok(plan("хочу на выставку").tags.includes("art"));
});

test("короткие корни не ловятся внутри чужих слов", ()=>{
  assert.ok(!plan("нас восемь человек, хочу выпить").tags.includes("family"),"восемь ≠ семья");
  assert.ok(!plan("хочу спать, найди отель").tags.includes("spa"),"спать ≠ спа");
  assert.ok(!plan("концерт в Крокусе").tags.includes("rock"),"Крокус ≠ рок");
  assert.ok(!plan("победа над скукой").tags.includes("food"),"победа ≠ еда");
  assert.ok(!plan("барбершоп рядом").tags.includes("bar"),"барбершоп ≠ бар");
  assert.ok(!plan("квартал красных фонарей").tags.includes("art"),"квартал ≠ арт");
  assert.ok(!plan("паблик-ток о науке").tags.includes("bar"),"паблик ≠ паб");
});

test("ядро запроса очищено от стоп-слов", ()=>{
  const p=plan("куда сходить в Москве");
  assert.equal(p.coreQuery,"");
  assert.deepEqual(p.eventQueries,[]);
  assert.deepEqual(p.placeQueries,[]);
  assert.equal(plan("найди что-нибудь про динозавров").coreQuery,"динозавров");
});

test("бесплатно и бюджет", ()=>{
  const p=plan("что-нибудь бесплатно");
  assert.equal(p.freeOnly,true);
  assert.equal(p.coreQuery,"");
  assert.equal(buildSearchPlan({query:"стендап",max_price_rub:0}).freeOnly,true);
  assert.equal(buildSearchPlan({query:"стендап",max_price_rub:1500}).maxPrice,1500);
});

test("флаг heavyDrinkingPhrase и безопасный запрос", ()=>{
  const p=plan("хочу выпить очень много");
  assert.equal(p.heavyDrinkingPhrase,true);
  assert.ok(p.tags.includes("bar"));
  assert.ok(!/очень|много/.test(p.safeQuery));
});

test("консьерж понимает не только досуг, но и услуги", ()=>{
  const cases=[
    ["хочу постричься","barber"],["нужен барбершоп","barber"],["маникюр на завтра","nails"],
    ["запиши к стоматологу","dentist"],["где аптека","pharmacy"],["нужен врач","clinic"],
    ["ветеринар для кота","vet"],["помыть машину","carwash"],["шиномонтаж срочно","carrepair"],
    ["ремонт телефона","phonerepair"],["распечатать документы","print"],["химчистка рядом","laundry"],
    ["нотариус","legal"],["где банкомат","bank"],["пункт выдачи","post"],
    ["купить цветы","flowers"],["книжный магазин","books"],["где переночевать","hotel"],
    ["каток","icerink"],["бассейн","pool"],["скалодром","climbing"],["тренажерный зал","gym"],
    ["йога студия","yoga"],["тату салон","tattoo"],["курсы английского","courses"],
    ["погулять в парке","park"],["сходить в музей","museum"],["в кино","cinema"],
    ["зоомагазин","petshop"],["фотостудия","photo"],["заправка","fuel"],["парковка","parking"]
  ];
  for(const [q,tag] of cases){
    const p=buildSearchPlan({query:q});
    assert.ok(p.tags.includes(tag),`${q} → ожидался тег ${tag}, получено: ${p.tags.join(",")||"ничего"}`);
    assert.ok(p.placeQueries.length,`${q} → нет запросов к провайдерам`);
  }
});

test("незнакомое название ищется по имени в OpenStreetMap", async ()=>{
  const {osmFilters}=await import("../providers.mjs");
  const p=buildSearchPlan({query:"додо пицца рядом"});
  const f=osmFilters(p);
  assert.ok(f.length,"фильтры построены");
  const named=buildSearchPlan({query:"вкусвилл"});
  const f2=osmFilters(named);
  assert.ok(f2.some(x=>x.includes('"name"~')),"поиск по названию: "+f2.join(" "));
});
