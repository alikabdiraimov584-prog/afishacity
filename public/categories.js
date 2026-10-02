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
  {tag:"hookah",re:/кальян|покурить|hookah|shisha/,queries:["кальянная","кальян-бар","лаунж бар"],en:["hookah","shisha","sheesha","lounge"],queriesEn:["hookah lounge","shisha cafe","lounge bar"],extraTags:["lounge","nightlife"],
   osm:['nwr["amenity"="hookah_lounge"]({{bbox}});','nwr["name"~"кальян|hookah|shisha",i]({{bbox}});']},
  {tag:"bar",re:new RegExp(`${B}(гастробар|гастропаб|рюмочн|наливочн|бар(?!бер|аба|бек|он|ин|сук|рикад|окко|вих|хат|селон|ан|ьер|мен|ж|д)|паб(?!лик)|пив[ао]|пивн(?:ой|ая|ые|ым)|вин[оа]${E}|винн|винотек)|(?<![a-z])pub(?!li)|выпить|коктейл|алкогол|дринк`),
   queries:["бар","паб","коктейльный бар"],en:["bars?","pubs?","drinks?","cocktails?","wine","beer","brewery","taproom","have a drink","go drinking","nightcap","rooftop bar"],queriesEn:["bar","pub","cocktail bar"],extraTags:["nightlife"],osm:['nwr["amenity"~"bar|pub|biergarten"]({{bbox}});']},
  {tag:"food",re:/ресторан|поесть|ужин|(?<![а-я])ед[аыеу](?![а-я])|кухн|кафе|завтрак|бранч|перекус|(?<![а-я])(пообедать|обед)/,
   queries:["ресторан","кафе"],en:["restaurants?","dinner","lunch","breakfast","brunch","eat","eating","food","cuisine","dine","dining","hungry","snack","bistro","steakhouse","burgers?","pizza","sushi","shawarma","grill"],queriesEn:["restaurant","cafe"],osm:['nwr["amenity"~"restaurant|cafe|fast_food"]({{bbox}});']},
  {tag:"coffee",re:/кофе|кофейн|капучино|раф(?![а-я])/,queries:["кофейня"],en:["coffee","cafes?","caf[eé]s?","espresso","cappuccino","latte","flat white"],queriesEn:["coffee shop","specialty coffee"],osm:['nwr["amenity"="cafe"]["cuisine"="coffee_shop"]({{bbox}});','nwr["amenity"="cafe"]({{bbox}});']},
  {tag:"bakery",re:/пекарн|(?<![а-я])хлеб|круассан|булочн/,queries:["пекарня"],en:["bakery","bakeries","bread","croissants?","pastries","pastry shop"],queriesEn:["bakery"],osm:['nwr["shop"="bakery"]({{bbox}});']},
  {tag:"pastry",re:/кондитерск|(?<![а-я])торт|пирожн|десерт|сладк/,queries:["кондитерская","торты"],en:["cakes?","desserts?","sweets","confectionery","patisserie"],queriesEn:["patisserie","cakes"],osm:['nwr["shop"~"confectionery|pastry"]({{bbox}});']},
  {tag:"winestore",service:true,re:/винотек|алкомаркет|купить вин|бутылк/,queries:["винотека","алкомаркет"],en:["wine shop","liquor store","bottle shop","buy wine","buy alcohol","off.?licen[cs]e"],queriesEn:["liquor store","wine shop"],osm:['nwr["shop"~"alcohol|wine"]({{bbox}});']},
  {tag:"grocery",service:true,re:/продукт|супермаркет|магазин у дома|за продуктами|бакале/,queries:["супермаркет","продукты"],en:["grocery","groceries","supermarket","convenience store","mini.?mart"],queriesEn:["supermarket","grocery store"],osm:['nwr["shop"~"supermarket|convenience|greengrocer"]({{bbox}});']},
  {tag:"market",re:/(?<![а-я])рынок|рынк|фермерск|ярмарк[а-я]* выходн/,queries:["рынок","фермерский рынок"],en:["markets?","farmers market","souq","souk","bazaar"],queriesEn:["market","farmers market"],osm:['nwr["amenity"="marketplace"]({{bbox}});']},

  // ---- Ночь и развлечения ----
  {tag:"karaoke",re:/караоке/,queries:["караоке"],en:["karaoke","sing"],queriesEn:["karaoke"],extraTags:["nightlife"],osm:['nwr["karaoke"="yes"]({{bbox}});','nwr["name"~"караоке|karaoke",i]({{bbox}});']},
  {tag:"club",re:/(?<![а-я])клуб(?!ник|нич|ен|к)|танц|вечеринк|тусовк|дискотек|рейв/,queries:["ночной клуб","бар с танцами"],en:["clubs?","nightclubs?","clubbing","dance","dancing","party","parties","rave","dj"],queriesEn:["nightclub","dance club"],extraTags:["nightlife","music"],osm:['nwr["amenity"="nightclub"]({{bbox}});']},
  {tag:"bowling",re:/боулинг/,queries:["боулинг"],en:["bowling"],queriesEn:["bowling"],extraTags:["active"],osm:['nwr["leisure"="bowling_alley"]({{bbox}});']},
  {tag:"billiards",re:/бильярд|пул(?![а-я])|снукер/,queries:["бильярд"],en:["billiards?","pool table","snooker","pool hall"],queriesEn:["billiards"],extraTags:["active"],osm:['nwr["sport"="billiards"]({{bbox}});']},
  {tag:"quest",re:/квест|перформанс|escape/,queries:["квест","квест-комната"],en:["escape rooms?","quest rooms?","escape games?"],queriesEn:["escape room"],extraTags:["active"],osm:['nwr["leisure"="escape_game"]({{bbox}});','nwr["name"~"квест|escape",i]({{bbox}});']},
  {tag:"vr",re:/(?<![а-я])vr(?![а-я])|виртуальн реальност/,queries:["vr клуб","виртуальная реальность"],en:["virtual reality","vr arcade"],queriesEn:["vr arcade","virtual reality"],extraTags:["active"],osm:['nwr["name"~"vr|виртуальн",i]({{bbox}});']},
  {tag:"shooting",re:/(?<![а-я])тир(?![а-я])|пострелять|стрельб/,queries:["тир","стрелковый клуб"],en:["shooting range","gun range","archery"],queriesEn:["shooting range"],extraTags:["active"],osm:['nwr["sport"="shooting"]({{bbox}});']},
  {tag:"karting",re:/картинг|покататься на карт/,queries:["картинг"],en:["karting","go.?karts?","go.?karting"],queriesEn:["go karting"],extraTags:["active"],osm:['nwr["sport"="karting"]({{bbox}});']},
  // ---- Дубай: чего не было в московском справочнике ----
  {tag:"theatre",re:/театр|спектакл|мюзикл|опер[аыу](?![а-я])|балет/,queries:["театр"],en:["theat(?:er|re)s?","plays?","musicals?","opera","ballet","show tonight"],queriesEn:["theatre","opera house"],extraTags:["culture"],osm:['nwr["amenity"="theatre"]({{bbox}});']},
  {tag:"concert",re:/концерт|живая музык|концертн/,queries:["концертный зал","клуб с живой музыкой"],en:["concerts?","live music","gigs?","concert hall","arena","music venue"],queriesEn:["concert hall","live music venue"],extraTags:["music","nightlife"],osm:['nwr["amenity"~"music_venue|arts_centre|events_venue"]({{bbox}});']},
  {tag:"themepark",re:/парк развлечен|парк аттракцион|аттракцион|диснейленд/,queries:["парк развлечений"],en:["theme parks?","amusement parks?","rides","rollercoaster","img worlds","motiongate","legoland","ferrari world","fun park"],queriesEn:["theme park","amusement park"],extraTags:["family","active"],osm:['nwr["tourism"="theme_park"]({{bbox}});','nwr["leisure"="amusement_arcade"]({{bbox}});']},
  {tag:"golf",re:/гольф/,queries:["гольф-клуб"],en:["golf","golf course","mini golf","driving range"],queriesEn:["golf club"],extraTags:["active"],osm:['nwr["leisure"~"golf_course|miniature_golf"]({{bbox}});']},
  {tag:"mosque",service:true,re:/мечет|намаз|помолиться/,queries:["мечеть"],en:["mosques?","masjid","pray(?:er)?","jummah"],queriesEn:["mosque"],osm:['nwr["amenity"="place_of_worship"]["religion"="muslim"]({{bbox}});']},
  {tag:"boat",re:/яхт|катер|прогулк[аи] на лодк|морск[а-я]* прогулк|лодк/,queries:["аренда яхт","прогулка на катере"],en:["yachts?","boat(?: tour| trip| ride| rental)?s?","cruise","dhow","marina","jet ?ski","fishing trip"],queriesEn:["yacht charter","boat tour","marina"],extraTags:["outdoors","experience"],osm:['nwr["amenity"="boat_rental"]({{bbox}});','nwr["leisure"="marina"]({{bbox}});','nwr["shop"="boat"]({{bbox}});']},
  {tag:"tours",re:/экскурси|сафари|тур(?![а-я])|туры|пустын/,queries:["экскурсии","турагентство"],en:["tours?","excursions?","desert safari","safari","dune bashing","guided","sightseeing tour","day trip","hot air balloon"],queriesEn:["desert safari","tour operator"],extraTags:["experience","outdoors"],osm:['nwr["shop"="travel_agency"]({{bbox}});','nwr["office"~"travel_agent|guide"]({{bbox}});','nwr["tourism"="information"]["information"="office"]({{bbox}});']},
  {tag:"carrental",service:true,re:/аренд[а-я]* (машин|авто)|прокат (машин|авто)|каршеринг/,queries:["аренда автомобилей"],en:["car rental","rent a car","car hire","hire a car"],queriesEn:["car rental"],osm:['nwr["amenity"="car_rental"]({{bbox}});']},
  {tag:"clothes",service:true,re:/одежд|(?<![а-я])обув|бутик|платье|кроссовк/,queries:["магазин одежды"],en:["clothes","clothing","fashion","boutiques?","shoes","sneakers","dress(?:es)?","abaya"],queriesEn:["clothing store","boutique"],osm:['nwr["shop"~"clothes|shoes|boutique|fashion"]({{bbox}});']},
  {tag:"jewelry",service:true,re:/ювелир|золот|украшени/,queries:["ювелирный магазин"],en:["jewel(?:le)?ry","gold","gold souk","rings?","watches"],queriesEn:["jewelry store","gold souk"],osm:['nwr["shop"~"jewelry|watches"]({{bbox}});']},
  {tag:"perfume",service:true,re:/парфюм|духи|(?<![а-я])уд(?![а-я])|бахур/,queries:["парфюмерия"],en:["perfumes?","fragrances?","oud","bakhoor","scent"],queriesEn:["perfume shop","oud perfume"],osm:['nwr["shop"="perfumery"]({{bbox}});']},
  {tag:"electronics",service:true,re:/электроник|ноутбук|айфон|смартфон|наушник|техник[уаи] купить/,queries:["магазин электроники"],en:["electronics","laptops?","iphone","smartphones?","headphones","gadgets?","camera store"],queriesEn:["electronics store"],osm:['nwr["shop"~"electronics|mobile_phone|computer"]({{bbox}});']},
  {tag:"hospital",service:true,re:/больниц|госпитал|скорая|травмпункт|неотложк/,queries:["больница"],en:["hospitals?","emergency","er","a&e","urgent care"],queriesEn:["hospital"],osm:['nwr["amenity"="hospital"]({{bbox}});']},
  {tag:"supermarket",service:true,re:/супермаркет|продукт[ыов]|магазин у дома/,queries:["супермаркет"],en:["supermarkets?","groceries","grocery store","carrefour","spinneys","waitrose","lulu"],queriesEn:["supermarket"],osm:['nwr["shop"~"supermarket|convenience"]({{bbox}});']},
  {tag:"cinema",re:/(?<![а-я])кино(?![а-я])|кинотеатр|(?<![а-я])фильм/,queries:["кинотеатр"],en:["cinemas?","movies?","film","imax","movie theat(?:er|re)"],queriesEn:["cinema"],extraTags:["culture"],osm:['nwr["amenity"="cinema"]({{bbox}});']},
  {tag:"aquapark",re:/аквапарк/,queries:["аквапарк"],en:["water ?parks?","aquapark","aquaventure","wild wadi"],queriesEn:["water park"],extraTags:["active","family"],osm:['nwr["leisure"="water_park"]({{bbox}});']},
  {tag:"zoo",re:/зоопарк|океанариум/,queries:["зоопарк","океанариум"],en:["zoo","aquarium","safari park"],queriesEn:["zoo","aquarium"],extraTags:["family"],osm:['nwr["tourism"~"zoo|aquarium"]({{bbox}});']},

  // ---- Культура и прогулки ----
  {tag:"museum",re:/(?<![а-я])музе[йяюеи](?![а-я])|музейн/,queries:["музей"],en:["museums?"],queriesEn:["museum"],extraTags:["culture"],osm:['nwr["tourism"="museum"]({{bbox}});']},
  {tag:"gallery",re:/галере|арт.?пространств/,queries:["галерея"],en:["galler(?:y|ies)","art space","art exhibition","exhibition"],queriesEn:["art gallery"],extraTags:["culture","art"],osm:['nwr["tourism"="gallery"]({{bbox}});']},
  {tag:"library",re:/библиотек|читальн/,queries:["библиотека"],en:["librar(?:y|ies)","reading room"],queriesEn:["library"],extraTags:["work","culture"],osm:['nwr["amenity"="library"]({{bbox}});']},
  // Пляж и достопримечательности — главные туристические запросы Дубая; в
  // Москве их почти не задают, поэтому русские шаблоны узкие.
  {tag:"beach",re:/пляж|искупаться|позагорать/,queries:["пляж"],en:["beach(?:es)?","swim(?:ming)?","sunbath(?:e|ing)?","beach club"],queriesEn:["beach","beach club"],extraTags:["outdoors"],osm:['nwr["natural"="beach"]({{bbox}});','nwr["leisure"="beach_resort"]({{bbox}});']},
  {tag:"sights",re:/достопримечательн|что посмотреть|смотровая|осмотреть город/,queries:["достопримечательность"],en:["sights?","sightseeing","landmarks?","attractions?","must.?see","viewpoints?","observation deck","tourist spots?","what to see"],queriesEn:["tourist attraction","landmark","viewpoint"],extraTags:["culture"],osm:['nwr["tourism"="attraction"]({{bbox}});','nwr["tourism"="viewpoint"]({{bbox}});']},
  {tag:"park",re:/(?<![а-я])парк(и|е|а|ов|ах|у)?(?![а-я])|погулять|прогулк|набережн|сквер|подышать/,queries:["парк","набережная"],en:["parks?(?! my car| the car)","walks?","walking","stroll(?:ing)?","promenade","corniche","waterfront","fresh air","picnic"],queriesEn:["park","promenade"],extraTags:["outdoors"],osm:['nwr["leisure"="park"]({{bbox}});']},
  {tag:"planetarium",re:/планетари|обсерватор/,queries:["планетарий"],en:["planetarium","observatory"],queriesEn:["planetarium"],extraTags:["family","culture"],osm:['nwr["amenity"="planetarium"]({{bbox}});']},

  // ---- Красота ----
  {tag:"barber",service:true,re:/барбершоп|постричь|подстричь|стрижк|парикмахер|(?<![а-я])бритье|побрить/,queries:["барбершоп","парикмахерская"],en:["barbers?","barbershop","haircut","hair ?cut","hairdresser","hair salon","trim","shave","grooming"],queriesEn:["barbershop","hair salon"],extraTags:["beauty"],
   osm:['nwr["shop"="hairdresser"]({{bbox}});','nwr["name"~"барбершоп|barber",i]({{bbox}});']},
  {tag:"nails",service:true,re:/маникюр|педикюр|(?<![а-я])ногт/,queries:["маникюр","ногтевая студия"],en:["nails?","manicure","pedicure","nail salon"],queriesEn:["nail salon","manicure"],extraTags:["beauty"],osm:['nwr["shop"="beauty"]({{bbox}});','nwr["name"~"маникюр|ногт|nail",i]({{bbox}});']},
  {tag:"cosmetology",service:true,re:/косметолог|(?<![а-я])бров|ресниц|шугаринг|эпиляц|чистка лица/,queries:["косметология","салон красоты"],en:["cosmetolog(?:y|ist)","facial","brows?","lashes","waxing","laser hair removal","sugaring"],queriesEn:["cosmetology clinic","beauty salon"],extraTags:["beauty"],osm:['nwr["shop"="beauty"]({{bbox}});']},
  {tag:"beauty",service:true,re:/салон красот|(?<![а-я])beauty|уход за соб/,queries:["салон красоты"],en:["beauty salon","beauty","self.?care"],queriesEn:["beauty salon"],osm:['nwr["shop"~"beauty|hairdresser"]({{bbox}});']},
  {tag:"tattoo",service:true,re:/(?<![а-я])тату|татуиров|пирсинг/,queries:["тату-салон","пирсинг"],en:["tattoos?","piercing"],queriesEn:["tattoo studio","piercing"],extraTags:["beauty"],osm:['nwr["shop"="tattoo"]({{bbox}});']},

  // ---- Здоровье и спорт ----
  {tag:"spa",re:new RegExp(`${B}бан(я|и|ю|е|ей)${E}|саун|${B}спа${E}|хамам|парн(ая|ой|ую|ые)${E}|парилк`),queries:["баня","сауна","спа"],en:["spa","sauna","hammam","steam room","bathhouse","moroccan bath","jacuzzi"],queriesEn:["spa","hammam","sauna"],osm:['nwr["leisure"="spa"]({{bbox}});','nwr["amenity"="sauna"]({{bbox}});']},
  {tag:"massage",service:true,re:/массаж/,queries:["массаж","спа"],en:["massage"],queriesEn:["massage","spa"],extraTags:["spa"],osm:['nwr["shop"="massage"]({{bbox}});','nwr["name"~"массаж|massage",i]({{bbox}});']},
  {tag:"gym",re:/тренажерн|качалк|фитнес|спортзал|(?<![а-я])зал[ыа]? для занятий|тренировк|(?<![а-я])жим(?![а-я])/,queries:["фитнес-клуб","тренажёрный зал"],en:["gym","gyms","fitness","workout","work out","training","crossfit","weights"],queriesEn:["gym","fitness club"],extraTags:["active"],osm:['nwr["leisure"="fitness_centre"]({{bbox}});']},
  {tag:"yoga",re:/(?<![а-я])йог[аиу](?![а-я])|пилатес|растяжк|стретчинг|медитац/,queries:["йога","студия йоги"],en:["yoga","pilates","stretching","meditation","breathwork"],queriesEn:["yoga studio","pilates"],extraTags:["active","spa"],osm:['nwr["leisure"="fitness_centre"]["sport"="yoga"]({{bbox}});','nwr["name"~"йога|yoga",i]({{bbox}});']},
  {tag:"pool",re:/бассейн|поплавать|(?<![а-я])плаван/,queries:["бассейн"],en:["swimming pool","swimming","swim","lap pool"],queriesEn:["swimming pool"],extraTags:["active"],osm:['nwr["leisure"="swimming_pool"]({{bbox}});','nwr["leisure"="sports_centre"]["sport"="swimming"]({{bbox}});']},
  {tag:"icerink",re:/(?<![а-я])катк?[оае][мкв]?(?![а-я])|(?<![а-я])коньк(и|ах|ами|ов|обежн)(?![а-я])|(?<![а-я])лед(?![а-я])/,queries:["каток"],en:["ice rink","ice skating","skating rink","skate"],queriesEn:["ice rink"],extraTags:["active","family"],osm:['nwr["leisure"="ice_rink"]({{bbox}});']},
  {tag:"climbing",re:/скалодром|лазать|боулдеринг/,queries:["скалодром"],en:["climbing","bouldering","climbing gym"],queriesEn:["climbing gym"],extraTags:["active"],osm:['nwr["sport"="climbing"]({{bbox}});']},
  {tag:"tennis",re:/теннис|падел|сквош|бадминтон/,queries:["теннисный корт","падел"],en:["tennis","padel","squash","badminton","pickleball"],queriesEn:["tennis court","padel court"],extraTags:["active"],osm:['nwr["sport"~"tennis|padel|squash"]({{bbox}});']},
  {tag:"clinic",service:true,re:/(?<![а-я])врач|клиник|поликлиник|терапевт|анализ[ыов]|(?<![а-я])узи(?![а-я])|больниц/,queries:["медицинский центр","клиника"],en:["doctors?","clinics?","hospital","physician","gp","medical cent(?:er|re)","ultrasound","blood test","check.?up"],queriesEn:["medical center","clinic"],osm:['nwr["amenity"~"clinic|doctors|hospital"]({{bbox}});']},
  {tag:"dentist",service:true,re:/стоматолог|зубн|(?<![а-я])зуб(?![а-я])/,queries:["стоматология"],en:["dentists?","dental","tooth","teeth"],queriesEn:["dental clinic"],osm:['nwr["amenity"="dentist"]({{bbox}});']},
  {tag:"pharmacy",service:true,re:/(?<![а-я])аптек(а|и|у|е|ой|ах|ами)?(?![а-я])|аптечн|лекарств|таблетк/,queries:["аптека"],en:["pharmac(?:y|ies)","drugstore","chemist","medicine","pills","painkillers?"],queriesEn:["pharmacy"],osm:['nwr["amenity"="pharmacy"]({{bbox}});']},
  {tag:"optics",service:true,re:/оптик|(?<![а-я])очк[иа](?![а-я])|(?<![а-я])линз/,queries:["оптика"],en:["optician","optics","glasses","eyewear","contact lenses","lenses"],queriesEn:["optician"],osm:['nwr["shop"="optician"]({{bbox}});']},

  // ---- Дети и питомцы ----
  {tag:"family",re:/ребен|(?<![а-я])дет(и|ей|ям|ьми|ск|ишк)|(?<![а-я])семь[яиею]|семейн/,queries:["детский центр","семейный ресторан","интерактивный музей"],en:["kids?","children","child","family","toddlers?","with my (?:kid|son|daughter)"],queriesEn:["kids activities","family restaurant","kids play area"],
   osm:['nwr["leisure"="playground"]({{bbox}});','nwr["amenity"~"cinema|theatre"]({{bbox}});']},
  {tag:"vet",service:true,re:/ветеринар|ветклиник|ветврач|ветаптек|прививк[ауи]? (кошк|собак)|стерилизац/,queries:["ветеринарная клиника"],en:["vets?","veterinar(?:y|ian)","vet clinic","pet vaccination"],queriesEn:["veterinary clinic"],osm:['nwr["amenity"="veterinary"]({{bbox}});']},
  {tag:"petshop",service:true,re:/зоомагазин|корм для|(?<![а-я])груминг|подстричь собак/,queries:["зоомагазин","груминг"],en:["pet shop","pet store","pet food","pet grooming","dog grooming"],queriesEn:["pet shop","pet grooming"],osm:['nwr["shop"~"pet|pet_grooming"]({{bbox}});']},

  // ---- Работа и услуги ----
  {tag:"work",re:/коворкинг|поработать|ноутбук|деловая встреч|переговорн|бизнес.?ланч/,queries:["коворкинг","кафе для работы"],en:["coworking","co.?working","work from","laptop","business meeting","meeting room","business lunch","get some work done"],queriesEn:["coworking space","laptop friendly cafe"],osm:['nwr["office"="coworking"]({{bbox}});','nwr["amenity"="cafe"]({{bbox}});']},
  {tag:"print",service:true,re:/распечат|копицентр|типографи|ксерокс|напечатат/,queries:["копицентр","печать документов"],en:["print","printing","copy shop","photocopy","xerox","typography"],queriesEn:["print shop","printing"],osm:['nwr["shop"="copyshop"]({{bbox}});']},
  {tag:"bank",service:true,re:/(?<![а-я])банк(и|е|ов|ом)?(?![а-я])|банкомат|отделени[ея] банк|обменник|обмен валют/,queries:["банк","банкомат"],en:["banks?","atm","cash machine","exchange","currency exchange","money exchange"],queriesEn:["bank","atm","currency exchange"],osm:['nwr["amenity"~"bank|bureau_de_change|atm"]({{bbox}});']},
  {tag:"post",service:true,re:/(?<![а-я])почт(?!и(?![а-я]))|посылк|отправить письмо|пункт выдач|(?<![а-я])пвз(?![а-я])/,queries:["почта","пункт выдачи"],en:["post office","parcel","courier","mail","pickup point","collection point"],queriesEn:["post office","parcel pickup"],osm:['nwr["amenity"="post_office"]({{bbox}});','nwr["shop"="outpost"]({{bbox}});']},
  {tag:"laundry",service:true,re:/прачечн|химчистк|постирать|(?<![а-я])стирк/,queries:["прачечная","химчистка"],en:["laundry","laundromat","dry clean(?:ing|er)?","wash my clothes"],queriesEn:["laundry","dry cleaning"],osm:['nwr["shop"~"laundry|dry_cleaning"]({{bbox}});']},
  {tag:"tailor",service:true,re:/ателье|подшить|ремонт одежд|ремонт обув|(?<![а-я])сапожник/,queries:["ателье","ремонт обуви"],en:["tailors?","alterations?","hem","clothes repair","shoe repair","cobbler"],queriesEn:["tailor","shoe repair"],osm:['nwr["shop"~"tailor|shoe_repair"]({{bbox}});']},
  {tag:"keys",service:true,re:/(?<![а-я])ключ[иа](?![а-я])|сделать ключ|замок помен/,queries:["изготовление ключей"],en:["keys?","key cutting","locksmith","change the lock"],queriesEn:["locksmith","key cutting"],osm:['nwr["shop"="locksmith"]({{bbox}});']},
  {tag:"phonerepair",service:true,re:/ремонт телефон|разбил экран|замена экран|сервисный центр/,queries:["ремонт телефонов"],en:["phone repair","screen repair","cracked screen","broken screen","fix my phone","service cent(?:er|re)"],queriesEn:["phone repair"],osm:['nwr["shop"="mobile_phone"]["repair"~"."]({{bbox}});','nwr["name"~"ремонт телефон|phone repair|mobile repair",i]({{bbox}});']},
  {tag:"photo",service:true,re:/фотостуди|фотограф|фото на документ/,queries:["фотостудия","фото на документы"],en:["photo studio","photographer","passport photos?","photo shoot"],queriesEn:["photo studio","passport photo"],osm:['nwr["shop"="photo"]({{bbox}});','nwr["craft"="photographer"]({{bbox}});']},
  {tag:"courses",re:/курсы|обучен|языков школ|репетитор|мастер.?класс по/,queries:["курсы","языковая школа"],en:["courses?","classes","lessons","language school","tutor","workshop on","learn"],queriesEn:["courses","language school"],osm:['nwr["amenity"="language_school"]({{bbox}});','nwr["office"="educational_institution"]({{bbox}});']},
  {tag:"legal",service:true,re:/нотариус|юрист|адвокат|мфц(?![а-я])|госуслуг/,queries:["нотариус","юрист"],en:["notary","lawyers?","attorney","legal","typing cent(?:er|re)","government services","amer cent(?:er|re)"],queriesEn:["notary","lawyer"],osm:['nwr["office"~"lawyer|notary|government"]({{bbox}});']},

  // ---- Машина и дорога ----
  {tag:"carwash",service:true,re:/автомойк|помыть машин|(?<![а-я])мойк/,queries:["автомойка"],en:["car wash","wash my car","carwash"],queriesEn:["car wash"],osm:['nwr["amenity"="car_wash"]({{bbox}});']},
  {tag:"carrepair",service:true,re:/автосервис|шиномонтаж|автомастерск|техобслуживан|ремонт машин|ремонт авто|развал.схожден/,queries:["автосервис","шиномонтаж"],en:["car repair","mechanic","garage","tyres?","tires?","car service","oil change","wheel alignment"],queriesEn:["car repair","tyre shop"],osm:['nwr["shop"~"car_repair|tyres"]({{bbox}});']},
  {tag:"fuel",service:true,re:/заправк|бензин|азс(?![а-я])|зарядк для электро/,queries:["заправка"],en:["gas station","petrol station","petrol","fuel","ev charging","charging station"],queriesEn:["petrol station"],osm:['nwr["amenity"="fuel"]({{bbox}});','nwr["amenity"="charging_station"]({{bbox}});']},
  {tag:"parking",service:true,re:/парковк|где оставить машин|припарков/,queries:["парковка"],en:["parking","park my car","car park"],queriesEn:["parking"],osm:['nwr["amenity"="parking"]({{bbox}});']},

  // ---- Покупки и ночлег ----
  {tag:"mall",service:true,re:/торгов[а-я]* центр|(?<![а-я])тц(?![а-я])|(?<![а-я])молл(?![а-я])|шопинг|купить одежд|за покупк/,queries:["торговый центр"],en:["malls?","shopping","shopping cent(?:er|re)","buy clothes","go shopping","outlet"],queriesEn:["shopping mall"],osm:['nwr["shop"~"mall|department_store"]({{bbox}});']},
  {tag:"flowers",service:true,re:/(?<![а-я])цвет(ы|ов|очн[а-я]*|ок)(?![а-я])|букет|флорист/,queries:["цветы","доставка букетов"],en:["flowers?","florist","bouquet"],queriesEn:["florist","flower delivery"],osm:['nwr["shop"="florist"]({{bbox}});']},
  {tag:"gifts",service:true,re:/подар|сувенир/,queries:["подарки","сувениры"],en:["gifts?","present","souvenirs?"],queriesEn:["gift shop","souvenirs"],osm:['nwr["shop"~"gift|souvenir"]({{bbox}});']},
  {tag:"books",service:true,re:/книжн|(?<![а-я])книг/,queries:["книжный магазин"],en:["books?","bookshop","bookstore"],queriesEn:["bookstore"],osm:['nwr["shop"="books"]({{bbox}});']},
  {tag:"hotel",service:true,re:/(?<![а-я])отел[ья]|гостиниц|хостел|переночевать|апартамент/,queries:["отель","хостел"],en:["hotels?","hostel","stay the night","place to stay","apartments?","resort"],queriesEn:["hotel","hostel"],osm:['nwr["tourism"~"hotel|hostel|guest_house"]({{bbox}});']},

  // ---- Поводы (не место, а сценарий) ----
  {tag:"date",re:/свидан|романт|вдвоем|вдвоём/,queries:["ресторан","винный бар","коктейльный бар"],en:["date","romantic","for two","anniversary","date night"],queriesEn:["restaurant","wine bar","cocktail bar"]},
  {tag:"birthday",re:/день рождения|праздн|юбиле|корпоратив|(?<![а-я])компан/,queries:["лофт","караоке","квест","ресторан"],en:["birthday","celebrate","celebration","party for","corporate","team event","group of"],queriesEn:["loft","karaoke","escape room","restaurant"],extraTags:["friends"]}
];

// Английские синонимы (поле en) приклеиваем к русскому шаблону с ASCII-границами
// слова: «bar» не должен ловить «barber», а «pub» — «public». Русская часть
// шаблона не меняется, поэтому поведение на русских запросах прежнее.
const AB="(?<![a-z])",AE="(?![a-z])";
for(const c of CATEGORIES){
  c.reRu=c.re;
  if(c.en&&c.en.length)c.re=new RegExp(c.re.source+"|"+AB+"(?:"+c.en.join("|")+")"+AE,c.re.flags);
}
// Поисковые фразы для провайдеров на языке города: по-русски для Москвы,
// по-английски для Дубая. Без языка — русские, как было.
function queriesFor(cat,lang){
  const c=typeof cat==="string"?CATEGORIES.find(x=>x.tag===cat):cat;
  if(!c)return [];
  return lang==="en"&&c.queriesEn&&c.queriesEn.length?c.queriesEn:(c.queries||[]);
}

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

root.FreeCategories={CATEGORIES,CATEGORY_MATCHERS,SERVICE_TAGS,categoryTags,queriesFor};
})(typeof globalThis!=="undefined"?globalThis:this);
