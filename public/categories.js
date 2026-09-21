(function(root){
"use strict";
// Справочник категорий FREE (изоморфный: браузер и сервер): один источник правды для разбора запроса, поиска по провайдерам,
// фильтров OpenStreetMap и ранжирования. Консьерж должен закрывать любой городской запрос,
// а не только досуг, поэтому здесь и развлечения, и услуги, и бытовые дела.
//
// В JS \b не работает с кириллицей, поэтому границы слов задаём через lookbehind/lookahead.
// Все регэкспы применяются к нормализованному тексту: нижний регистр, ё→е, пунктуация → пробелы.
const B="(?<![а-я])";           // начало кириллического слова
const E="(?![а-я])";            // конец кириллического слова

const CATEGORIES=[
  // ---- Еда и напитки ----
  {tag:"hookah",re:/кальян|покурить|hookah|shisha/,queries:["кальянная","кальян-бар","лаунж бар"],extraTags:["lounge","nightlife"],
   osm:['nwr["amenity"="hookah_lounge"]({{bbox}});','nwr["name"~"кальян|hookah|shisha",i]({{bbox}});']},
  {tag:"bar",re:new RegExp(`${B}(гастробар|гастропаб|рюмочн|наливочн|бар(?!бер|аба|бек|он|ин|сук|рикад|окко|вих|хат|селон|ан|ьер|мен|ж|д)|паб(?!лик)|пив[ао]|пивн(?:ой|ая|ые|ым)|вин[оа]${E}|винн|винотек)|(?<![a-z])pub(?!li)|выпить|коктейл|алкогол|дринк`),
   queries:["бар","паб","коктейльный бар"],extraTags:["nightlife"],osm:['nwr["amenity"~"bar|pub|biergarten"]({{bbox}});']},
  {tag:"food",re:/ресторан|поесть|ужин|(?<![а-я])ед[аыеу](?![а-я])|кухн|кафе|завтрак|бранч|перекус|(?<![а-я])(пообедать|обед)/,
   queries:["ресторан","кафе"],osm:['nwr["amenity"~"restaurant|cafe|fast_food"]({{bbox}});']},
  {tag:"coffee",re:/кофе|кофейн|капучино|раф(?![а-я])/,queries:["кофейня"],osm:['nwr["amenity"="cafe"]["cuisine"="coffee_shop"]({{bbox}});','nwr["amenity"="cafe"]({{bbox}});']},
  {tag:"bakery",re:/пекарн|(?<![а-я])хлеб|круассан|булочн/,queries:["пекарня"],osm:['nwr["shop"="bakery"]({{bbox}});']},
  {tag:"pastry",re:/кондитерск|(?<![а-я])торт|пирожн|десерт|сладк/,queries:["кондитерская","торты"],osm:['nwr["shop"~"confectionery|pastry"]({{bbox}});']},
  {tag:"winestore",service:true,re:/винотек|алкомаркет|купить вин|бутылк/,queries:["винотека","алкомаркет"],osm:['nwr["shop"~"alcohol|wine"]({{bbox}});']},
  {tag:"grocery",service:true,re:/продукт|супермаркет|магазин у дома|за продуктами|бакале/,queries:["супермаркет","продукты"],osm:['nwr["shop"~"supermarket|convenience|greengrocer"]({{bbox}});']},
  {tag:"market",re:/(?<![а-я])рынок|рынк|фермерск|ярмарк[а-я]* выходн/,queries:["рынок","фермерский рынок"],osm:['nwr["amenity"="marketplace"]({{bbox}});']},

  // ---- Ночь и развлечения ----
  {tag:"karaoke",re:/караоке/,queries:["караоке"],extraTags:["nightlife"],osm:['nwr["karaoke"="yes"]({{bbox}});','nwr["name"~"караоке|karaoke",i]({{bbox}});']},
  {tag:"club",re:/(?<![а-я])клуб(?!ник|нич|ен|к)|танц|вечеринк|тусовк|дискотек|рейв/,queries:["ночной клуб","бар с танцами"],extraTags:["nightlife","music"],osm:['nwr["amenity"="nightclub"]({{bbox}});']},
  {tag:"bowling",re:/боулинг/,queries:["боулинг"],extraTags:["active"],osm:['nwr["leisure"="bowling_alley"]({{bbox}});']},
  {tag:"billiards",re:/бильярд|пул(?![а-я])|снукер/,queries:["бильярд"],extraTags:["active"],osm:['nwr["sport"="billiards"]({{bbox}});']},
  {tag:"quest",re:/квест|перформанс|escape/,queries:["квест","квест-комната"],extraTags:["active"],osm:['nwr["leisure"="escape_game"]({{bbox}});','nwr["name"~"квест",i]({{bbox}});']},
  {tag:"vr",re:/(?<![а-я])vr(?![а-я])|виртуальн реальност/,queries:["vr клуб","виртуальная реальность"],extraTags:["active"],osm:['nwr["name"~"vr|виртуальн",i]({{bbox}});']},
  {tag:"shooting",re:/(?<![а-я])тир(?![а-я])|пострелять|стрельб/,queries:["тир","стрелковый клуб"],extraTags:["active"],osm:['nwr["sport"="shooting"]({{bbox}});']},
  {tag:"karting",re:/картинг|покататься на карт/,queries:["картинг"],extraTags:["active"],osm:['nwr["sport"="karting"]({{bbox}});']},
  {tag:"cinema",re:/(?<![а-я])кино(?![а-я])|кинотеатр|(?<![а-я])фильм/,queries:["кинотеатр"],extraTags:["culture"],osm:['nwr["amenity"="cinema"]({{bbox}});']},
  {tag:"aquapark",re:/аквапарк/,queries:["аквапарк"],extraTags:["active","family"],osm:['nwr["leisure"="water_park"]({{bbox}});']},
  {tag:"zoo",re:/зоопарк|океанариум/,queries:["зоопарк","океанариум"],extraTags:["family"],osm:['nwr["tourism"~"zoo|aquarium"]({{bbox}});']},

  // ---- Культура и прогулки ----
  {tag:"museum",re:/(?<![а-я])музе[йяюеи](?![а-я])|музейн/,queries:["музей"],extraTags:["culture"],osm:['nwr["tourism"="museum"]({{bbox}});']},
  {tag:"gallery",re:/галере|арт.?пространств/,queries:["галерея"],extraTags:["culture","art"],osm:['nwr["tourism"="gallery"]({{bbox}});']},
  {tag:"library",re:/библиотек|читальн/,queries:["библиотека"],extraTags:["work","culture"],osm:['nwr["amenity"="library"]({{bbox}});']},
  {tag:"park",re:/(?<![а-я])парк(и|е|а|ов|ах|у)?(?![а-я])|погулять|прогулк|набережн|сквер|подышать/,queries:["парк","набережная"],extraTags:["outdoors"],osm:['nwr["leisure"="park"]({{bbox}});']},
  {tag:"planetarium",re:/планетари|обсерватор/,queries:["планетарий"],extraTags:["family","culture"],osm:['nwr["amenity"="planetarium"]({{bbox}});']},

  // ---- Красота ----
  {tag:"barber",service:true,re:/барбершоп|постричь|подстричь|стрижк|парикмахер|(?<![а-я])бритье|побрить/,queries:["барбершоп","парикмахерская"],extraTags:["beauty"],
   osm:['nwr["shop"="hairdresser"]({{bbox}});','nwr["name"~"барбершоп|barber",i]({{bbox}});']},
  {tag:"nails",service:true,re:/маникюр|педикюр|(?<![а-я])ногт/,queries:["маникюр","ногтевая студия"],extraTags:["beauty"],osm:['nwr["shop"="beauty"]({{bbox}});','nwr["name"~"маникюр|ногт|nail",i]({{bbox}});']},
  {tag:"cosmetology",service:true,re:/косметолог|(?<![а-я])бров|ресниц|шугаринг|эпиляц|чистка лица/,queries:["косметология","салон красоты"],extraTags:["beauty"],osm:['nwr["shop"="beauty"]({{bbox}});']},
  {tag:"beauty",service:true,re:/салон красот|(?<![а-я])beauty|уход за соб/,queries:["салон красоты"],osm:['nwr["shop"~"beauty|hairdresser"]({{bbox}});']},
  {tag:"tattoo",service:true,re:/(?<![а-я])тату|татуиров|пирсинг/,queries:["тату-салон","пирсинг"],extraTags:["beauty"],osm:['nwr["shop"="tattoo"]({{bbox}});']},

  // ---- Здоровье и спорт ----
  {tag:"spa",re:new RegExp(`${B}бан(я|и|ю|е|ей)${E}|саун|${B}спа${E}|хамам|парн(ая|ой|ую|ые)${E}|парилк`),queries:["баня","сауна","спа"],osm:['nwr["leisure"="spa"]({{bbox}});','nwr["amenity"="sauna"]({{bbox}});']},
  {tag:"massage",service:true,re:/массаж/,queries:["массаж","спа"],extraTags:["spa"],osm:['nwr["shop"="massage"]({{bbox}});','nwr["name"~"массаж",i]({{bbox}});']},
  {tag:"gym",re:/тренажерн|качалк|фитнес|спортзал|(?<![а-я])зал[ыа]? для занятий|тренировк|(?<![а-я])жим(?![а-я])/,queries:["фитнес-клуб","тренажёрный зал"],extraTags:["active"],osm:['nwr["leisure"="fitness_centre"]({{bbox}});']},
  {tag:"yoga",re:/(?<![а-я])йог[аиу](?![а-я])|пилатес|растяжк|стретчинг|медитац/,queries:["йога","студия йоги"],extraTags:["active","spa"],osm:['nwr["leisure"="fitness_centre"]["sport"="yoga"]({{bbox}});','nwr["name"~"йога|yoga",i]({{bbox}});']},
  {tag:"pool",re:/бассейн|поплавать|(?<![а-я])плаван/,queries:["бассейн"],extraTags:["active"],osm:['nwr["leisure"="swimming_pool"]({{bbox}});','nwr["leisure"="sports_centre"]["sport"="swimming"]({{bbox}});']},
  {tag:"icerink",re:/(?<![а-я])катк?[оае][мкв]?(?![а-я])|(?<![а-я])коньк(и|ах|ами|ов|обежн)(?![а-я])|(?<![а-я])лед(?![а-я])/,queries:["каток"],extraTags:["active","family"],osm:['nwr["leisure"="ice_rink"]({{bbox}});']},
  {tag:"climbing",re:/скалодром|лазать|боулдеринг/,queries:["скалодром"],extraTags:["active"],osm:['nwr["sport"="climbing"]({{bbox}});']},
  {tag:"tennis",re:/теннис|падел|сквош|бадминтон/,queries:["теннисный корт","падел"],extraTags:["active"],osm:['nwr["sport"~"tennis|padel|squash"]({{bbox}});']},
  {tag:"clinic",service:true,re:/(?<![а-я])врач|клиник|поликлиник|терапевт|анализ[ыов]|(?<![а-я])узи(?![а-я])|больниц/,queries:["медицинский центр","клиника"],osm:['nwr["amenity"~"clinic|doctors|hospital"]({{bbox}});']},
  {tag:"dentist",service:true,re:/стоматолог|зубн|(?<![а-я])зуб(?![а-я])/,queries:["стоматология"],osm:['nwr["amenity"="dentist"]({{bbox}});']},
  {tag:"pharmacy",service:true,re:/(?<![а-я])аптек(а|и|у|е|ой|ах|ами)?(?![а-я])|аптечн|лекарств|таблетк/,queries:["аптека"],osm:['nwr["amenity"="pharmacy"]({{bbox}});']},
  {tag:"optics",service:true,re:/оптик|(?<![а-я])очк[иа](?![а-я])|(?<![а-я])линз/,queries:["оптика"],osm:['nwr["shop"="optician"]({{bbox}});']},

  // ---- Дети и питомцы ----
  {tag:"family",re:/ребен|(?<![а-я])дет(и|ей|ям|ьми|ск|ишк)|(?<![а-я])семь[яиею]|семейн/,queries:["детский центр","семейный ресторан","интерактивный музей"],
   osm:['nwr["leisure"="playground"]({{bbox}});','nwr["amenity"~"cinema|theatre"]({{bbox}});']},
  {tag:"vet",service:true,re:/ветеринар|ветклиник|ветврач|ветаптек|прививк[ауи]? (кошк|собак)|стерилизац/,queries:["ветеринарная клиника"],osm:['nwr["amenity"="veterinary"]({{bbox}});']},
  {tag:"petshop",service:true,re:/зоомагазин|корм для|(?<![а-я])груминг|подстричь собак/,queries:["зоомагазин","груминг"],osm:['nwr["shop"~"pet|pet_grooming"]({{bbox}});']},

  // ---- Работа и услуги ----
  {tag:"work",re:/коворкинг|поработать|ноутбук|деловая встреч|переговорн|бизнес.?ланч/,queries:["коворкинг","кафе для работы"],osm:['nwr["office"="coworking"]({{bbox}});','nwr["amenity"="cafe"]({{bbox}});']},
  {tag:"print",service:true,re:/распечат|копицентр|типографи|ксерокс|напечатат/,queries:["копицентр","печать документов"],osm:['nwr["shop"="copyshop"]({{bbox}});']},
  {tag:"bank",service:true,re:/(?<![а-я])банк(и|е|ов|ом)?(?![а-я])|банкомат|отделени[ея] банк|обменник|обмен валют/,queries:["банк","банкомат"],osm:['nwr["amenity"~"bank|bureau_de_change|atm"]({{bbox}});']},
  {tag:"post",service:true,re:/(?<![а-я])почт(?!и(?![а-я]))|посылк|отправить письмо|пункт выдач|(?<![а-я])пвз(?![а-я])/,queries:["почта","пункт выдачи"],osm:['nwr["amenity"="post_office"]({{bbox}});','nwr["shop"="outpost"]({{bbox}});']},
  {tag:"laundry",service:true,re:/прачечн|химчистк|постирать|(?<![а-я])стирк/,queries:["прачечная","химчистка"],osm:['nwr["shop"~"laundry|dry_cleaning"]({{bbox}});']},
  {tag:"tailor",service:true,re:/ателье|подшить|ремонт одежд|ремонт обув|(?<![а-я])сапожник/,queries:["ателье","ремонт обуви"],osm:['nwr["shop"~"tailor|shoe_repair"]({{bbox}});']},
  {tag:"keys",service:true,re:/(?<![а-я])ключ[иа](?![а-я])|сделать ключ|замок помен/,queries:["изготовление ключей"],osm:['nwr["shop"="locksmith"]({{bbox}});']},
  {tag:"phonerepair",service:true,re:/ремонт телефон|разбил экран|замена экран|сервисный центр/,queries:["ремонт телефонов"],osm:['nwr["shop"="mobile_phone"]["repair"~"."]({{bbox}});','nwr["name"~"ремонт телефон",i]({{bbox}});']},
  {tag:"photo",service:true,re:/фотостуди|фотограф|фото на документ/,queries:["фотостудия","фото на документы"],osm:['nwr["shop"="photo"]({{bbox}});','nwr["craft"="photographer"]({{bbox}});']},
  {tag:"courses",re:/курсы|обучен|языков школ|репетитор|мастер.?класс по/,queries:["курсы","языковая школа"],osm:['nwr["amenity"="language_school"]({{bbox}});','nwr["office"="educational_institution"]({{bbox}});']},
  {tag:"legal",service:true,re:/нотариус|юрист|адвокат|мфц(?![а-я])|госуслуг/,queries:["нотариус","юрист"],osm:['nwr["office"~"lawyer|notary|government"]({{bbox}});']},

  // ---- Машина и дорога ----
  {tag:"carwash",service:true,re:/автомойк|помыть машин|(?<![а-я])мойк/,queries:["автомойка"],osm:['nwr["amenity"="car_wash"]({{bbox}});']},
  {tag:"carrepair",service:true,re:/автосервис|шиномонтаж|автомастерск|техобслуживан|ремонт машин|ремонт авто|развал.схожден/,queries:["автосервис","шиномонтаж"],osm:['nwr["shop"~"car_repair|tyres"]({{bbox}});']},
  {tag:"fuel",service:true,re:/заправк|бензин|азс(?![а-я])|зарядк для электро/,queries:["заправка"],osm:['nwr["amenity"="fuel"]({{bbox}});','nwr["amenity"="charging_station"]({{bbox}});']},
  {tag:"parking",service:true,re:/парковк|где оставить машин|припарков/,queries:["парковка"],osm:['nwr["amenity"="parking"]({{bbox}});']},

  // ---- Покупки и ночлег ----
  {tag:"mall",service:true,re:/торгов[а-я]* центр|(?<![а-я])тц(?![а-я])|(?<![а-я])молл(?![а-я])|шопинг|купить одежд|за покупк/,queries:["торговый центр"],osm:['nwr["shop"~"mall|department_store"]({{bbox}});']},
  {tag:"flowers",service:true,re:/(?<![а-я])цвет(ы|ов|очн[а-я]*|ок)(?![а-я])|букет|флорист/,queries:["цветы","доставка букетов"],osm:['nwr["shop"="florist"]({{bbox}});']},
  {tag:"gifts",service:true,re:/подар|сувенир/,queries:["подарки","сувениры"],osm:['nwr["shop"~"gift|souvenir"]({{bbox}});']},
  {tag:"books",service:true,re:/книжн|(?<![а-я])книг/,queries:["книжный магазин"],osm:['nwr["shop"="books"]({{bbox}});']},
  {tag:"hotel",service:true,re:/(?<![а-я])отел[ья]|гостиниц|хостел|переночевать|апартамент/,queries:["отель","хостел"],osm:['nwr["tourism"~"hotel|hostel|guest_house"]({{bbox}});']},

  // ---- Поводы (не место, а сценарий) ----
  {tag:"date",re:/свидан|романт|вдвоем|вдвоём/,queries:["ресторан","винный бар","коктейльный бар"]},
  {tag:"birthday",re:/день рождения|праздн|юбиле|корпоратив|(?<![а-я])компан/,queries:["лофт","караоке","квест","ресторан"],extraTags:["friends"]}
];

// Регэкспы для определения тегов у найденного места по его названию и описанию.
const CATEGORY_MATCHERS=CATEGORIES.map(c=>[c.tag,c.re]);

// Услуги подтверждает только категория из самого источника, а не текст названия:
// «Аптекарский огород» — это парк, сколько бы раз в имени ни встретилось «аптек».
const SERVICE_TAGS=new Set(CATEGORIES.filter(c=>c.service).map(c=>c.tag));

function categoryTags(text){
  const out=[];
  for(const c of CATEGORIES)if(c.re.test(text))out.push(c.tag,...(c.extraTags||[]));
  return [...new Set(out)];
}

root.FreeCategories={CATEGORIES,CATEGORY_MATCHERS,SERVICE_TAGS,categoryTags};
})(typeof globalThis!=="undefined"?globalThis:this);
