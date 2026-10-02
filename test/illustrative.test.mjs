// Фото у каждой карточки: снимок с сайта места, а если его нет — фото для
// примера того же рода мест с подписью. Пустая обложка — только когда нет и этого.
import test from "node:test";
import assert from "node:assert/strict";
import {illustrativeKeys,illustrativeFor,setIllustrativePool} from "../illustrative.mjs";
import {resolvePhoto} from "../photos.mjs";

const POOL={
  "cat:food":[{url:"https://img.example/food1.jpg",creator:"Ann",landing:"https://flickr.example/1",license:"CC BY 2.0",license_url:"https://creativecommons.org/licenses/by/2.0/"}],
  "cui:sushi":[{url:"https://img.example/sushi.jpg",creator:"Ken",landing:"https://flickr.example/2",license:"CC BY 2.0"}],
  "act:skydiving":[{url:"https://img.example/sky.jpg",creator:"Bo",landing:"https://flickr.example/3",license:"CC BY 2.0"}],
  "cat:beach":[{url:"https://img.example/beach.jpg",creator:"Li",landing:"https://flickr.example/4",license:"CC0"}]
};

test("фото для примера выбирается по занятию, кухне и рубрике", () => {
  assert.equal(illustrativeKeys({name:"Skydive Dubai",cat_tags:["tours"]})[0],"act:skydiving");
  assert.equal(illustrativeKeys({name:"Mori",cuisine:"sushi;japanese",cat_tags:["food"]})[0],"cui:sushi");
  assert.equal(illustrativeKeys({name:"Tokyo Corner",ov_cat:"sushi_restaurant",cat_tags:["food"]})[0],"cui:sushi");
  assert.deepEqual(illustrativeKeys({name:"Kite Beach",cat_tags:["beach","outdoors"]}),["cat:beach","cat:outdoors"]);
  // Кухня не подменяет рубрику у не-еды: «Thai» у массажа — не тайская кухня.
  assert.ok(!illustrativeKeys({name:"Thai Massage",cat_tags:["massage","spa"]}).some(k=>k.startsWith("cui:")));
});

test("фото для примера подписано как пример и с автором", () => {
  setIllustrativePool(POOL);
  try{
    const a=illustrativeFor({id:"osm:node:1",name:"Mori",cuisine:"sushi",cat_tags:["food"]});
    assert.equal(a.url,"https://img.example/sushi.jpg");
    assert.match(a.credit.text,/(Фото для примера|Illustrative photo) · Ken/);
    assert.equal(a.credit.url,"https://flickr.example/2");
    // Нет своего набора — берётся набор рубрики.
    assert.equal(illustrativeFor({id:"x",name:"Al Mallah",cat_tags:["food"]}).url,"https://img.example/food1.jpg");
    // Ничего не подошло — null, дальше своя обложка.
    assert.equal(illustrativeFor({id:"y",name:"Laundry",cat_tags:["laundry"]}),null);
  }finally{setIllustrativePool({})}
});

test("в одной выдаче соседние карточки не повторяют кадр, пока есть свободные", () => {
  setIllustrativePool({
    "cui:sushi":[{url:"s1",creator:"A"},{url:"s2",creator:"B"}],
    "cat:food":[{url:"f1",creator:"C"},{url:"f2",creator:"D"}]
  });
  try{
    const used=new Set();
    const urls=[1,2,3,4].map(n=>illustrativeFor({id:"p"+n,name:"Sushi "+n,cuisine:"sushi",cat_tags:["food"]},{used}).url);
    assert.equal(new Set(urls).size,4,"4 разных кадра: сперва суши, потом еда");
    assert.deepEqual(urls.slice(0,2).sort(),["s1","s2"]);
    // Всё занято — повтор, но не пустота.
    assert.ok(illustrativeFor({id:"p5",name:"Sushi 5",cuisine:"sushi",cat_tags:["food"]},{used}).url);
    // Без used выбор стабилен: одно и то же место — один и тот же кадр.
    assert.equal(illustrativeFor({id:"p1",name:"x",cuisine:"sushi"}).url,illustrativeFor({id:"p1",name:"x",cuisine:"sushi"}).url);
  }finally{setIllustrativePool({})}
});

test("каскад: фото с сайта места выше примера, пример выше своей обложки", async () => {
  const cover=()=>"/api/cover.svg?x";
  const il={url:"https://img.example/food1.jpg",credit:{text:"Illustrative photo · Ann",url:"https://flickr.example/1"},license:{code:"CC BY 2.0",url:"https://cc.example"}};
  const withSite={id:"a",name:"Zuma",official_source:"https://zuma.example/",site_photo:{url:"https://zuma.example/hero.jpg",w:1200,h:800}};
  const p1=await resolvePhoto(withSite,{coverUrl:cover,illustrative:()=>il});
  assert.equal(p1.origin,"venue_site");
  assert.equal(p1.url,"https://zuma.example/hero.jpg");
  assert.equal(p1.credit.text,"zuma.example");
  const p2=await resolvePhoto({id:"b",name:"Nameless"},{coverUrl:cover,lookup:async()=>null,illustrative:()=>il});
  assert.equal(p2.origin,"illustrative");
  assert.ok(p2.credit&&p2.credit.text,"у примера есть подпись");
  const p3=await resolvePhoto({id:"c",name:"Nameless"},{coverUrl:cover,lookup:async()=>null,illustrative:()=>null});
  assert.equal(p3.origin,"generated");
  // Логотип вместо фото с сайта не принимается.
  const p4=await resolvePhoto({id:"d",name:"Z",official_source:"https://z.example/",site_photo:{url:"https://z.example/logo.png",w:300,h:300}},{coverUrl:cover,illustrative:()=>il});
  assert.equal(p4.origin,"illustrative");
});
