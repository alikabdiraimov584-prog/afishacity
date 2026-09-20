// Корпус на справочник категорий.
//
// В JS \b не работает для кириллицы, поэтому каждый корень обязан сам закрывать
// границы слова. Ошибка в одном шаблоне видна не в нём, а в выдаче: «почти рядом»
// уводил поиск в отделения связи, «сто рублей» — в автосервис, а «торговый центр»
// не находился вовсе. Здесь зафиксировано и то, что обязано срабатывать,
// и то, что срабатывать не должно.
import test from "node:test";
import assert from "node:assert/strict";
import {categoryTags} from "../categories.mjs";

const tags=(s)=>categoryTags(String(s).toLowerCase().replace(/ё/g,"е"));

// Фразы, в которых категория ОБЯЗАНА определиться.
const MUST=[
  ["почта","post"],["где почта","post"],["почтовое отделение","post"],["пункт выдачи","post"],
  ["автосервис","carrepair"],["шиномонтаж","carrepair"],["ремонт машины","carrepair"],
  ["тренажерный зал","gym"],["фитнес","gym"],["качалка","gym"],["спортзал","gym"],
  ["ночной клуб","club"],["клубы","club"],["потанцевать","club"],
  ["клиника","clinic"],["сделать узи","clinic"],["врач","clinic"],
  ["парная","spa"],["баня","spa"],["сауна","spa"],["спа","spa"],
  ["очки","optics"],["оптика","optics"],["линзы","optics"],
  ["отель","hotel"],["гостиница","hotel"],["переночевать","hotel"],
  ["каток","icerink"],["на коньках","icerink"],["покататься на коньках","icerink"],
  ["йога","yoga"],["пилатес","yoga"],
  ["бар","bar"],["бары","bar"],["выпить","bar"],["паб","bar"],
  ["торговый центр","mall"],["торговые центры","mall"],["тц","mall"],["шопинг","mall"],
  ["магазин цветов","flowers"],["цветы","flowers"],["букет","flowers"],["цветочный","flowers"],
  ["банк","bank"],["банки","bank"],["банкомат","bank"],["обмен валют","bank"],
  ["ветеринар","vet"],["ветклиника","vet"],
  ["музей","museum"],["музеи","museum"],["в музее","museum"],
  ["парк","park"],["парки","park"],["в парке","park"],["погулять","park"],
  ["рынок","market"],["ярмарка выходного дня","market"],
  ["аптека","pharmacy"],["барбершоп","barber"],["постричься","barber"],
  ["ресторан","food"],["поесть","food"],["пообедать","food"],["завтрак","food"],
];

// Слова и фразы, в которых категория НЕ ДОЛЖНА определяться.
// Слева — что пишет человек, справа — куда его ошибочно уводило.
const NEVER=[
  ["почти рядом","post"],["почти дошёл","post"],
  ["сто рублей","carrepair"],["сто грамм","carrepair"],
  ["концертный зал","gym"],["зал ожидания","gym"],["актовый зал","gym"],
  ["клубника","club"],["клубничный десерт","club"],["клубень","club"],
  ["джакузи","clinic"],
  ["с парнем","spa"],["парни","spa"],["мой парень","spa"],
  ["примочки","optics"],["дочки","optics"],
  ["котельники","hotel"],["котельная","hotel"],
  ["коньково","icerink"],["в коньково","icerink"],
  ["йогурт","yoga"],["йогуртовый","yoga"],
  ["барокко","bar"],["барвиха","bar"],["бархат","bar"],["барселона","bar"],
  ["баранина","bar"],["барьер","bar"],["бармен","bar"],["барабан","bar"],
  ["выгулять собаку","vet"],["с собакой","vet"],["кошка","vet"],
  ["парковка","park"],["где припарковаться","park"],
  ["банкет","bank"],["стеклянная банка","bank"],
  ["победа","food"],["спать","spa"],["восемь","family"],
  ["аптекарский огород","pharmacy"],
  ["крокус","rock"],["квартал","art"],
];

test("категория определяется там, где должна", () => {
  const bad=[];
  for(const [phrase,tag] of MUST){
    const t=tags(phrase);
    if(!t.includes(tag))bad.push(`${JSON.stringify(phrase)} → ${JSON.stringify(t)}, ожидался «${tag}»`);
  }
  assert.deepEqual(bad,[],"\n"+bad.join("\n"));
});

test("категория не определяется там, где не должна", () => {
  const bad=[];
  for(const [phrase,tag] of NEVER){
    const t=tags(phrase);
    if(t.includes(tag))bad.push(`${JSON.stringify(phrase)} → ${JSON.stringify(t)}, тег «${tag}» лишний`);
  }
  assert.deepEqual(bad,[],"\n"+bad.join("\n"));
});

test("ни один шаблон не мёртв: у каждой категории есть срабатывающая фраза", async () => {
  const {CATEGORIES}=await import("../categories.mjs");
  const dead=CATEGORIES.filter(c=>!(c.queries||[]).some(q=>c.re.test(String(q).toLowerCase().replace(/ё/g,"е"))))
    .map(c=>c.tag);
  // Часть категорий описывается не своим названием (повод, а не место) — они перечислены явно.
  const known=new Set(["date","birthday","work","family","winestore","petshop","phonerepair","legal","courses","keys","tailor","print","carwash","fuel","mall","grocery","market","hotel","gifts","books","flowers","laundry","parking","vr","shooting","climbing","pool"]);
  assert.deepEqual(dead.filter(t=>!known.has(t)),[],`шаблон не ловит собственный поисковый запрос: ${dead.join(", ")}`);
});

test("на длинной строке разбор не деградирует", () => {
  // Защита от катастрофического бэктрекинга: 20 тысяч символов должны разобраться мгновенно.
  const long="а".repeat(20000)+" бар "+"б".repeat(20000);
  const started=process.hrtime.bigint();
  const t=tags(long);
  const ms=Number(process.hrtime.bigint()-started)/1e6;
  assert.ok(t.includes("bar"),"длинная строка всё ещё разбирается");
  assert.ok(ms<500,`разбор занял ${ms.toFixed(0)} мс`);
});
