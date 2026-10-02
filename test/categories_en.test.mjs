// Английский корпус справочника категорий (город Дубай, LANG=en).
//
// Английские синонимы приклеены к русским шаблонам с ASCII-границами слова,
// поэтому здесь проверяем и то, что обязано срабатывать, и то, что
// срабатывать не должно: «barber» — не «bar», «public» — не «pub».
import test from "node:test";
import assert from "node:assert/strict";
import {CATEGORIES,categoryTags,queriesFor} from "../categories.mjs";

const tags=(s)=>categoryTags(String(s).toLowerCase());

const MUST=[
  ["want a drink","bar"],["where can i grab a cocktail","bar"],["pubs nearby","bar"],["rooftop bar","bar"],
  ["shisha near me","hookah"],["hookah lounge","hookah"],
  ["where to have dinner","food"],["i'm hungry","food"],["brunch spot","food"],["breakfast","food"],
  ["coffee","coffee"],["specialty coffee","coffee"],["a nice cafe","coffee"],
  ["yoga","yoga"],["pilates class","yoga"],
  ["gym near me","gym"],["padel court","tennis"],
  ["spa and hammam","spa"],["massage","massage"],
  ["i need a haircut","barber"],["barbershop","barber"],["nail salon","nails"],
  ["pharmacy","pharmacy"],["drugstore open now","pharmacy"],["dentist","dentist"],["doctor","clinic"],
  ["nightclub","club"],["go dancing","club"],["karaoke","karaoke"],
  ["cinema tonight","cinema"],["movie","cinema"],
  ["museum","museum"],["art gallery","gallery"],["exhibition","gallery"],
  ["a walk on the beach","park"],["park","park"],
  ["parking","parking"],["park my car","parking"],
  ["shopping mall","mall"],["florist","flowers"],["hotel","hotel"],
  ["car wash","carwash"],["petrol station","fuel"],["atm","bank"],
  ["kids activities","family"],["vet clinic","vet"],["coworking","work"],
  ["date night","date"],["birthday party","birthday"],
  ["nearest metro station","metro"],["where is the metro","metro"],["dubai tram","metro"],["tram stop jbr","metro"],
  ["live music tonight","concert"],
];

const NEVER=[
  ["barber","bar"],["barbecue","bar"],["embarrassing","bar"],
  ["public library","bar"],["republic","bar"],
  ["parking","park"],["park my car","park"],
  ["yogurt","yoga"],["clubhouse sandwich","club"],
  ["business","bar"],
  // «near the metro» — ищут ресторан, а не станцию; арена — не концерт.
  ["restaurant near the metro","metro"],["hotel by the metro","metro"],["metro card top up","metro"],
  ["padel arena","concert"],["laser arena","concert"],
];

test("en: категория определяется там, где должна", () => {
  const bad=[];
  for(const [phrase,tag] of MUST){
    const t=tags(phrase);
    if(!t.includes(tag))bad.push(`${JSON.stringify(phrase)} → ${JSON.stringify(t)}, ожидался «${tag}»`);
  }
  assert.deepEqual(bad,[],"\n"+bad.join("\n"));
});

test("en: категория не определяется там, где не должна", () => {
  const bad=[];
  for(const [phrase,tag] of NEVER){
    const t=tags(phrase);
    if(t.includes(tag))bad.push(`${JSON.stringify(phrase)} → ${JSON.stringify(t)}, тег «${tag}» лишний`);
  }
  assert.deepEqual(bad,[],"\n"+bad.join("\n"));
});

test("en: у каждой категории есть английские синонимы и поисковые фразы", () => {
  const missing=CATEGORIES.filter(c=>!(c.en&&c.en.length)||!(c.queriesEn&&c.queriesEn.length)).map(c=>c.tag);
  assert.deepEqual(missing,[]);
});

test("queriesFor выбирает язык, по умолчанию — русский", () => {
  assert.deepEqual(queriesFor("bar"),["бар","паб","коктейльный бар"]);
  assert.deepEqual(queriesFor("bar","ru"),["бар","паб","коктейльный бар"]);
  assert.deepEqual(queriesFor("bar","en"),["bar","pub","cocktail bar"]);
  assert.deepEqual(queriesFor("nope","en"),[]);
  const c=CATEGORIES.find(x=>x.tag==="hookah");
  assert.deepEqual(queriesFor(c,"en"),c.queriesEn);
});

test("en: русские шаблоны не задеты — reRu совпадает с прежним поведением", () => {
  const bar=CATEGORIES.find(c=>c.tag==="bar");
  assert.ok(bar.reRu.test("бар"));
  assert.ok(!bar.reRu.test("want a drink"));
  assert.ok(bar.re.test("want a drink"));
});
