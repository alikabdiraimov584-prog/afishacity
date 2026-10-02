// Фото для примера — когда у самого места снимка нет.
//
// Карточка без картинки выглядит пустой, а настоящего фото есть не у каждого
// места: у половины нет сайта, у части сайт без картинки. Тогда показываем
// настоящую фотографию того же рода мест — суши для суши-бара, дюны для
// сафари, пляж для пляжа — со свободной лицензией и подписью «фото для
// примера», чтобы её не приняли за снимок именно этого заведения.
//
// Наборы собраны заранее (Openverse, лицензии CC с указанием автора) и лежат
// в photos_illustrative_<город>.json: {"cat:bar":[{url,creator,landing,license,license_url}], …}.
import {readFileSync} from "node:fs";
import {L,CITY} from "./city.mjs";

// Наборы — свои у каждого города: «пляж» и «виды» для Дубая Москве не годятся.
let POOL={};
try{POOL=JSON.parse(readFileSync(new URL(`./photos_illustrative_${CITY.id}.json`,import.meta.url),"utf8"))}catch{POOL={}}
export function illustrativePool(){return POOL}
export function setIllustrativePool(p){POOL=p&&typeof p==="object"?p:{}}

const norm=(v)=>String(v||"").toLowerCase().replace(/[_;,]+/g," ");

// Занятие узнаётся по названию и рубрике каталога: «Skydive Dubai», «sky_diving».
const ACTIVITY=[
  [/sky ?div/,"act:skydiving"],[/balloon/,"act:balloon"],[/helicopter|heli tour/,"act:helicopter"],
  [/jet ?ski/,"act:jetski"],[/kayak/,"act:kayak"],[/scuba|diving cent|dive cent|\bdiving\b/,"act:scuba"],
  [/camel/,"act:camel"],[/\bdhow/,"act:dhow"],[/paddle ?board|\bsup\b/,"act:paddleboarding"],
  [/zip ?line|xline/,"act:zipline"],[/padel/,"act:padel"],[/trampolin/,"act:trampoline"],
  [/laser ?tag|laser quest/,"act:lasertag"],[/paintball/,"act:paintball"],[/horse|equestrian|stable/,"act:horse"],
  [/archery/,"act:archery"],[/fishing/,"act:fishing"],[/snorkel/,"act:snorkel"],[/kite ?surf|kiteboard/,"act:kitesurf"],
  [/\bsurf/,"act:surf"],[/quad|buggy|dune bash/,"act:quad"],[/hammam/,"act:hammam"],[/pottery|ceramic/,"act:pottery"],
  [/cooking (?:class|school|studio)|culinary school|cookery/,"act:cooking"],[/dance (?:studio|school|academy|class)|ballet|salsa|zumba/,"act:dance"]
];
// Кухня — по тегу cuisine, рубрике каталога («sushi_restaurant») и названию.
const CUISINE=[
  [/sushi/,"cui:sushi"],[/ramen/,"cui:ramen"],[/japanese|izakaya|omakase/,"cui:japanese"],[/dim ?sum|dumpling|cantonese/,"cui:dimsum"],
  [/pizz/,"cui:pizza"],[/italian|pasta|trattoria|ristorante/,"cui:italian"],[/biryani/,"cui:biryani"],
  [/dosa|south indian|udupi|kerala/,"cui:dosa"],[/indian|curry|tandoor|punjabi|thali/,"cui:indian"],
  [/pakistan|karachi|lahor/,"cui:pakistani"],[/chinese|szechuan|sichuan|hunan/,"cui:chinese"],[/thai/,"cui:thai"],
  [/korean/,"cui:korean"],[/vietnam|\bpho\b/,"cui:vietnamese"],[/filipin/,"cui:filipino"],
  [/shawarma/,"cui:shawarma"],[/falafel/,"cui:falafel"],[/turk|kebab|doner|ottoman/,"cui:turkish"],
  [/persian|iranian/,"cui:persian"],[/lebanes|arab|emirati|middle eastern|syrian|levant|khaleeji|mandi/,"cui:arabic"],
  [/greek/,"cui:greek"],[/georgian|khachapuri/,"cui:georgian"],[/russian/,"cui:russian"],[/spanish|tapas|paella/,"cui:spanish"],
  [/mediterranean/,"cui:mediterranean"],[/mexican|taco|burrito|tex ?mex/,"cui:mexican"],[/french|bistro|brasserie/,"cui:french"],
  [/steak/,"cui:steak"],[/seafood|fish|lobster|oyster/,"cui:seafood"],[/burger|american|diner/,"cui:burger"],
  [/bbq|barbecue|grill/,"cui:bbq"],[/chicken|wings/,"cui:chicken"],[/poke/,"cui:poke"],
  [/vegan|vegetarian|plant based/,"cui:vegan"],[/healthy|salad|health food|juice/,"cui:healthy"],
  [/ice cream|gelato|dessert|frozen yogurt|kunafa|sweets|chocolat/,"cui:dessert"],[/afternoon tea|tea room|\btea\b/,"cui:tea"],
  [/brunch/,"cui:brunch"],[/breakfast|pancake/,"cui:breakfast"],[/asian|noodle|wok/,"cui:asian"]
];
// Категории, для которых кухня важнее рубрики (у кафе-кондитерской — сладкое).
const FOODISH=new Set(["food","coffee","bakery","pastry","bar","hookah"]);

function hash(s){let x=2166136261;for(const ch of String(s||""))x=Math.imul(x^ch.charCodeAt(0),16777619)>>>0;return x}

export function illustrativeKeys(place){
  const name=norm(place.name),ov=norm(place.ov_cat),cui=norm(place.cuisine),cat=norm(place.category);
  const cats=[...(Array.isArray(place.cat_tags)?place.cat_tags:[]),...(Array.isArray(place.primary_tags)?place.primary_tags:[])];
  const keys=[];
  const text=`${name} ${ov} ${cat}`;
  for(const [re,k] of ACTIVITY)if(re.test(text)){keys.push(k);break}
  if(!cats.length||cats.some(c=>FOODISH.has(c))){
    for(const [re,k] of CUISINE)if(re.test(`${cui} ${ov}`)){keys.push(k);break}
    for(const [re,k] of CUISINE)if(re.test(name)){keys.push(k);break}
  }
  for(const c of cats)keys.push(`cat:${c}`);
  return [...new Set(keys)];
}

function asResult(p,k){
  const who=p.creator?String(p.creator).slice(0,40):null;
  return {url:p.url,key:k,
    credit:{text:who?L(`Фото для примера · ${who}`,`Illustrative photo · ${who}`):L("Фото для примера","Illustrative photo"),url:p.landing||p.url},
    license:{code:p.license||"CC",url:p.license_url||p.landing||p.url}};
}
// used — кадры, уже показанные в этой выдаче: пять кофеен подряд с одной и той
// же картинкой выглядят как ошибка. Берём следующий свободный кадр темы, потом
// — кадр более общей темы (суши → еда), и только если всё занято — повтор.
export function illustrativeFor(place,{used=null}={}){
  const h=hash(place.id||place.name);
  let first=null;
  for(const k of illustrativeKeys(place)){
    const pool=POOL[k];
    if(!Array.isArray(pool)||!pool.length)continue;
    for(let j=0;j<pool.length;j++){
      const p=pool[(h+j)%pool.length];
      if(!p||!p.url)continue;
      if(!first)first=[p,k];
      if(used&&used.has(p.url))continue;
      if(used)used.add(p.url);
      return asResult(p,k);
    }
  }
  return first?asResult(first[0],first[1]):null;
}
