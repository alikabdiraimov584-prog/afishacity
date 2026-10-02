import json,re,sys,math,duckdb,unicodedata,hashlib,os
S=sys.argv[1]
osm=json.load(open(f"{S}/dubai_by_cat.json"))
cfg=json.load(open(f"{S}/cats.json"))
# --- Overture → наши категории (по детальной категории, затем по базовой) ---
RULES=[
 ("hookah",r"hookah|shisha"),("karaoke",r"karaoke"),("club",r"dance_club|night_?club|nightlife"),
 ("bar",r"(^|_)(bar|pub|lounge|brewery|beer_garden|wine_bar|cocktail_bar|sports_bar|speakeasy|taproom)$"),
 ("bowling",r"bowling"),("billiards",r"billiard"),("quest",r"escape"),("vr",r"virtual_reality"),
 ("shooting",r"shooting|gun_range|archery"),("karting",r"kart|motor_?sport|raceway|autodrome"),
 ("cinema",r"movie_theat|cinema|drive_in_theat"),("theatre",r"^(?!.*(movie|home_theat|cinema)).*theat(er|re)$|performing_arts|(^|_)opera(_house)?$"),("concert",r"music_venue|concert|stadium|arena"),
("aquapark",r"water_park"),
 ("themepark",r"amusement_park|theme_park|arcade|kids_recreation|trampoline|indoor_playcentre|indoor_play"),
 ("zoo",r"(^|_)zoo|aquarium|wildlife|safari_park"),
 ("park",r"(^|_)park$|botanical_garden|(^|_)garden$|nature_reserve|(^|_)lake$|promenade|waterfront"),("museum",r"museum"),("gallery",r"art_gallery|gallery"),
 ("library",r"^library"),("planetarium",r"planetarium"),
 ("beach",r"beach"),("sights",r"landmark|monument|tourist_attraction|observation_deck|observatory|viewpoint|scenic_point|lookout|palace|fort$|heritage_site"),
 ("golf",r"golf_course|golf_club|driving_range|mini_?golf|golf_instructor|(^|_)golf$"),("mosque",r"muslim_place_of_worship|mosque"),
 ("boat",r"boat_(rental|tour)|yacht|marina|jet_ski|charter|cruise|dhow|scuba|(?<!sky_)diving|water_?sports?|kayak|paddle|parasail|flyboard|surf"),
 ("tours",r"tour_operator|sightseeing|(^|_)tours?(_|$)|travel_agen|safari|balloon|desert|sky_?diving|paraglid|zip_?line|bungee|helicopter|adventure_sports"),
 ("carrental",r"car_rental|rent_a_car|vehicle_rental|bike_rental|bicycle_rental|scooter_rental|motorcycle_rental"),
 ("perfume",r"fragrance|perfume|oud"),("jewelry",r"jewel|watch_store|gold"),
 ("hardware",r"hardware_store|home_improvement_store|paint_store|tool_store|diy|building_supply_store|lumber"),
 ("electronics",r"electronics_store|mobile_phone_store|computer_store|camera|audio_visual|appliance_store|video_game_store"),
 ("clothes",r"clothing|apparel|fashion|boutique|shoe_store|bridal|lingerie|uniform_store|sportswear|abaya"),
 ("hospital",r"hospital|emergency|urgent_care"),("dentist",r"dent|orthodont"),("pharmacy",r"pharmacy|drug_store|drugstore"),
 ("optics",r"eyewear|optician|optical|optometr"),
 ("clinic",r"outpatient|clinic|naturopath|ayurved|chiropract|acupunct|physiotherap|homeopath|doctors_office|medical_center|health_care$|dermatolog|physical_therapy|laboratory_testing|pediatric|gynecolog|cardiolog|family_practice|general_practice"),
 ("barber",r"barber"),("nails",r"nail"),("tattoo",r"tattoo"),("massage",r"massage"),
 ("spa",r"(^|_)spa$|day_spa|health_spa|hammam|bath_house|sauna"),
 ("cosmetology",r"skin_care|laser_hair|aesthetic|medical_spa|cosmetic_surgery|plastic_and_reconstructive|eyelash|brow|waxing"),
 ("beauty",r"beauty_salon|hair_salon|makeup_artist"),
 ("yoga",r"yoga|pilates"),("climbing",r"climb|bouldering"),("icerink",r"ice_rink|skating"),
 ("tennis",r"tennis|padel|squash|badminton|pickleball"),("pool",r"swimming_pool|swim"),
 ("gym",r"(^|_)gym|fitness|crossfit|martial_arts|boxing|muay|bootcamp"),
 ("family",r"playground|kids|child|indoor_play"),
 ("vet",r"veterinar|animal_hospital"),("petshop",r"(^|_)pet_(store|supply|groomer|grooming|shop)"),
 ("work",r"cowork|business_center|shared_office"),("print",r"printing|copy_shop|print_shop"),
 ("bank",r"(^|_)bank|atm$|currency_exchange|money_transfer"),("post",r"post_office|mailbox"),
 ("laundry",r"laundr|dry_clean"),("tailor",r"tailor|sewing|alteration"),("keys",r"locksmith|key_dupl"),
 ("phonerepair",r"phone_repair|mobile_phone_repair|electronics_repair|computer_repair"),
 ("photo",r"photo_studio|photographer|photography_store|passport_photo"),
 ("courses",r"language_school|music_school|dance_studio|tutoring|driving_school|art_school|cooking_school|specialty_school|computer_coaching"),
 ("legal",r"attorney|law_firm|(^|_)law(_|$)|notary|legal"),
 ("carwash",r"car_wash|auto_detailing"),("carrepair",r"automotive_repair|auto_body|tire|automotive_service|car_repair|mechanic|oil_change|car_window"),
 ("fuel",r"gas_station|fuel|ev_charg"),("parking",r"^parking"),
 ("mall",r"shopping_mall|department_store|^shopping$|outlet_mall"),("flowers",r"florist|flowers"),
 ("gifts",r"gift|souvenir|party_supply|toy_store"),("books",r"book_?store"),
 ("hotel",r"hotel|resort|hostel|^lodging|service_apartment|guest_house|motel|bed_and_breakfast"),
 ("winestore",r"liquor|wine_shop|beer_store|wine_store"),
 ("supermarket",r"supermarket|warehouse_club|convenience_store|hypermarket"),
 ("grocery",r"grocery|produce_store|butcher|specialty_foods|health_food_store|delicatessen|organic_store"),
 ("market",r"(^|_)market$|flea_market|souk|bazaar"),
 ("pastry",r"dessert|ice_cream|chocolat|candy|frozen_yogurt|cake_shop|pastry|patisserie|creperie"),
 ("bakery",r"bakery|donut|bagel"),
 ("coffee",r"coffee|(^|_)cafe$|tea_room|bubble_tea|juice_bar|smoothie"),
 ("food",r"restaurant|eatery|food_court|buffet|steakhouse|diner|bistro|brasserie|kebab|sandwich|pizza|burger|fast_food|shawarma|food_truck|canteen|noodle|sushi|(^|_)grill"),
]
RULES=[(t,re.compile(p)) for t,p in RULES]
EXCLUDE=re.compile(r"cooperative|historic_site|milk_bar|juice_bar|salad_bar|oxygen_bar|nail_bar|brow_bar|blow_dry|dealer|dealership|equipment|_supply|supplies|business_park|office_park|technology_park|trailer_park|rv_park|manufactur|wholesal|supplier|distributor|b2b|(^|_)company$|corporate|industrial|contractor|real_estate|agency$|consult|government|university|college|embassy|repair_service$")
NAME_TAG=[("tours",re.compile(r"desert safari|dune bashing|safari tours?",re.I)),("hookah",re.compile(r"\b(shisha|hookah|argileh|nargil)",re.I)),("karaoke",re.compile(r"karaoke",re.I)),("bar",re.compile(r"\b(rooftop bar|cocktail|pub|speakeasy)\b",re.I))]
VALID={c["tag"] for c in cfg["cats"]}
NAMED_OVERRIDE=set()
FALLBACK_CATS={"travel_service","travel_company","travel_and_transportation","sports_and_recreation","sport_league","arts_and_entertainment","beauty_supply_store","medical_supply_store","medical_service_organization","food_and_drink","rental_service","discount_store","health_care","park","event_planning","party_and_event_planning","financial_service","social_or_community_service","b2b_science_and_technology_service","science_museum",""}
NAME_FALLBACK=[(t,re.compile(p,re.I)) for t,p in [
 ("vr",r"(^|[^a-z])vr([^a-z]|$)|virtual reality"),("planetarium",r"planetarium|astronom"),("pharmacy",r"\bpharmacy\b"),("dentist",r"\bdental\b|\bdentist"),
 ("clinic",r"\b(medical cent(er|re)|polyclinic|clinic)\b"),("boat",r"\b(yachts?|boats?|cruises?|dhow|jet ?ski|water ?sports?|kayak)\b"),
 ("tours",r"\b(desert safari|safari|tours?|sightseeing|excursions?|balloon)\b"),("perfume",r"\b(perfumes?|oud|fragrances?|attar)\b"),("bank",r"\b(exchange|remittance)\b")]]
B2B_NAME=re.compile(r"\b(contracting|contractors?|landscap\w*|construction|maintenance|technical services|manufactur\w*|wholesale|industries|industrial|logistics|freight|cargo|engineering|consultan\w*|real estate|properties|investments?|holding|fit ?out|interiors? design|joinery|scaffold\w*|recruitment|manpower|cleaning services|pest control|facility management|facilities management|welding|machinery|equipment|steel|metals?|chemicals?|plastics?|electromechanical|hvac|elevators?|generators?|scrap|packaging|printing press|transport(?:ation)? (?:llc|co)|shipping (?:llc|co)|ship ?chandl\w*|marine services|publishing|publishers?|printing and publishing|advertising|marketing agency|media production|management training|corporate training|certification|business setup|company formation|visa services|pro services|typing cent(?:er|re)|(?:seafood|foodstuffs?|meat|poultry|vegetables?|fruits?|spices?|rice|sugar) trading|will open|opening soon|coming soon|closed permanently|permanently closed)\b",re.I)
ELSEWHERE=re.compile(r"abu ?dhabi|abudhabi|ras al ?khaimah|\brak\b|fujairah|\bal ain\b|umm al quwain|lahore|karachi|islamabad|rawalpindi|mumbai|bombay|new delhi|kerala|kochi|hyderabad|bangalore|chennai|cairo|riyadh|jeddah|\bdoha\b|kuwait|bahrain|muscat|ethiopia|addis ababa|nairobi|manila|kathmandu|dhaka|colombo|tehran|istanbul|london|moscow|yas island|yas waterworld",re.I)
COURIER=re.compile(r"\b(emirates post|empost|dhl|fedex|aramex|ups|tnt|smsa|courier|post office|postal)\b",re.I)
VALIDATE={t:re.compile(p,re.I) for t,p in {"planetarium":r"planetar|astronom|observator|space|star|thuraya","golf":r"golf","icerink":r"\bice\b|skat|hockey|rink","climbing":r"climb|boulder|wall|rock|vertical","shooting":r"shoot|gun|range|archery|rifle|pistol|clay","karting":r"kart|karting|raceway|racing|autodrome|speedway|drift|circuit","mall":r"mall|cent(?:er|re)|souk|market|plaza|walk|outlet|galleria|avenue|village|square|boulevard|arcade|emporium|department|store|lafayette|harvey|bloomingdale|debenhams|marks|centrepoint|city","bowling":r"bowl|strike|lanes|games|fun|entertain|arcade","zoo":r"zoo|aquarium|safari|wildlife|bird|butterfly|reptile|farm|animal|green planet|dolphin|crocodile|petting","aquapark":r"water|aqua|wadi|splash|wave|slide","spa":r"\bspa\b|massage|wellness|hammam|\bbath|retreat|sauna|salon|beauty|thai|bali|ayurved|relax|oasis|sense|zen|lotus|therapy|resort|hotel|club","beach":r"beach|bay|cove|shore|plage|lagoon|coast|sand|island|kite|marina|resort|club|la mer|jbr|walk|\bsea\b|nikki|zero gravity|cove|surf|water|park","theatre":r"theat|opera|stage|playhouse|perform|drama|comedy|arts|show|auditorium","museum":r"museum|gallery|heritage|house|history|histor|frame|future|exhibit|centre|center|fort|archive|collection|majlis","vr":r"\bvr\b|virtual","quest":r"escape|quest|room|puzzle|mystery|exit|clue|locked|breakout|hysteria|blackout","karaoke":r"karaoke|sing|ktv|lounge|bar|club|box|room"}.items()}
VR_NAME=re.compile(r"(^|[^a-z])vr([^a-z0-9]|$)|virtual reality",re.I)
HERITAGE=re.compile(r"histor|heritage|\bfort\b|dubai frame|burj khalifa|burj al arab|museum|old town|\bsouk\b|bastak|shindagha|fahidi",re.I)
CUISINE_FIX={"arabian":"arab;arabic","middle_eastern":"middle_eastern;arabic","doner_kebab":"kebab","barbecue":"bbq;barbecue","bar_and_grill":"grill","sushi":"sushi;japanese","ramen":"ramen;japanese","afghani":"afghan","sri_lankan":"sri_lankan;srilankan","texmex":"mexican","health_food":"healthy","vegan":"vegan;vegetarian","fish_and_chips":"fish_and_chips;seafood;british","indo_chinese":"chinese;indian","poke":"poke;hawaiian","breakfast_and_brunch":"breakfast;brunch","taco":"mexican;tacos","pizza":"pizza;italian","burger":"burger","chicken":"chicken","theme":None,"buffet":"buffet","comfort_food":None,"cafeteria":None,"fast_food":None,"international_fusion":"fusion"}
def cuisine_of(keys):
  out=[]
  for k in keys:
    if not k:continue
    m=re.match(r"^([a-z_]+?)_restaurant$",k)
    base=m.group(1) if m else ("steak" if k=="steakhouse" else None)
    if not base:continue
    v=CUISINE_FIX.get(base,base)
    if v:
      for x in v.split(";"):
        if x not in out:out.append(x)
  return ";".join(out[:4])
def tags_for(cat,basic,name,alts):
  out=[]
  # Рубрика каталога явно не наша («milk_bar», «dealer», «agency») — общая
  # базовая рубрика («bar») не должна её подменять.
  if cat and EXCLUDE.search(cat):return []
  for key in [cat or "",*(alts or [])]:
    if not key or EXCLUDE.search(key):continue
    for t,rx in RULES:
      if rx.search(key) and t in VALID and t not in out:out.append(t);break
  if not out and basic and not EXCLUDE.search(basic):
    for t,rx in RULES:
      if rx.search(basic) and t in VALID:out.append(t);break
  for t,rx in NAME_TAG:
    if rx.search(name or "") and t not in out:out.insert(0,t);NAMED_OVERRIDE.add(name)
  # Категория в каталоге размытая («travel_service», «arts_and_entertainment»),
  # но название говорит само: «Desert Safari Dubai», «VR Park», «Aster Pharmacy».
  if not out and (cat or "") in FALLBACK_CATS and not EXCLUDE.search(basic or ""):
    for t,rx in NAME_FALLBACK:
      if rx.search(name or "") and t in VALID:out.append(t);break
  if (cat or "") in {"shipping_center","courier_service","freight_and_cargo_service","shipping_and_delivery"} and COURIER.search(name or "") and "post" not in out:out.append("post")
  # Редкие рубрики Overture перепроверяем по названию: «Pakistan Education
  # Academy» с рубрикой «планетарий», каратэ-школа с рубрикой «гольф».
  out=[t for t in out if t not in VALIDATE or VALIDATE[t].search(name or "")]
  if (cat or "") in {"park","arts_and_entertainment","amusement_park","arcade","",None} and VR_NAME.search(name or "") and "vr" not in out:out.insert(0,"vr")
  # Исторический объект в каталоге — чаще жилая башня; берём только явные.
  if not out and cat=="historic_site" and HERITAGE.search(name or ""):out.append("sights")
  return out[:3]
# Синтетический OSM-тег категории — первое условие её первого фильтра.
CL=re.compile(r'\[\s*"([^"]+)"\s*(=|~)\s*"([^"]*)"')
SYN={}
for c in cfg["cats"]:
  for f in c["osm"]:
    m=CL.search(f)
    if m and m.group(1)!="name":SYN[c["tag"]]=(m.group(1),re.sub(r"^\^\(|\)\$$","",m.group(3)).split("|")[0]);break
def norm(s):
  s=unicodedata.normalize("NFKD",str(s or "")).lower()
  s=re.sub(r"[̀-ͯ]","",s);s=re.sub(r"[^a-z0-9؀-ۿ ]+"," ",s)
  return " ".join(w for w in s.split() if w not in{"the","and","restaurant","cafe","dubai","llc","l","l c","branch"})
AR=re.compile(r"[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]+")
AR_CITY={"دبي":"Dubai","الشارقة":"Sharjah","عجمان":"Ajman","أبوظبي":"Abu Dhabi","ابوظبي":"Abu Dhabi"}
VIET=re.compile(r"[ầấậẩẫằắặẳẵềếệểễồốộổỗờớợởỡừứựửữỳỵỷỹđĐ]")
def clean_addr(a):
  a=str(a or "")
  # Многострочные «адреса» (списки врачей) и чужие адреса (вьетнамский) — мусор.
  a=re.sub(r"\s*[\r\n]+\s*",", ",a)
  if VIET.search(a):return ""
  if len(a)>110:a=a[:110].rsplit(",",1)[0]
  for k,v in AR_CITY.items():a=a.replace(k,v)
  a=AR.sub(" ",a)
  a=re.sub(r"\s*[,/|]+\s*",", ",a);a=re.sub(r"(, )+",", ",a);a=re.sub(r"\s{2,}"," ",a).strip(" ,-–—/|")
  # Повтор города («Dubai, Dubai») и адрес из одного города — не адрес.
  parts=[];[parts.append(x) for x in a.split(", ") if x and x not in parts]
  a=", ".join(parts)
  if not re.search(r"[A-Za-z]",a) or a.lower() in("dubai","sharjah","uae","dubai, uae","dubai, united arab emirates","united arab emirates"):return ""
  return a
PLACE_NAMES={"dubai","dubai uae","uae","united arab emirates","dubai united arab emirates","dubai marina","downtown","downtown dubai","business bay","palm jumeirah","jumeirah","deira","bur dubai","jbr","jlt","al barsha","sharjah","abu dhabi","jumeirah beach residence","jumeirah lake towers","difc","al quoz","dubai hills","dubai creek","dubai creek harbour","city walk","la mer","the palm","palm"}
def dist(a,b,c,d):
  return 6371000*2*math.asin(math.sqrt(math.sin(math.radians(c-a)/2)**2+math.cos(math.radians(a))*math.cos(math.radians(c))*math.sin(math.radians(d-b)/2)**2))
# Индекс OSM-мест по сетке для склейки дублей
grid={};allosm={}
for tag,els in osm.items():
  for e in els:
    k=(e["type"],e["id"]);allosm[k]=e
for k,e in allosm.items():
  lat=e.get("lat",e.get("center",{}).get("lat"));lon=e.get("lon",e.get("center",{}).get("lon"))
  grid.setdefault((round(lat,3),round(lon,3)),[]).append(e)
# Известные места OSM (wikidata, достопримечательность, ТЦ): у Overture под их
# именем десятки «двойников» в случайных точках — 38 «Dubai Mall», 19 «Burj
# Khalifa». Настоящее место берём из OSM, двойники выбрасываем.
NOTABLE={}
for k,e in allosm.items():
  t=e["tags"]
  if t.get("wikidata") or t.get("tourism") in("attraction","museum","theme_park","hotel","resort","zoo","aquarium","viewpoint") or t.get("leisure") in("water_park","resort") or t.get("historic") or (t.get("shop")=="mall" and not t.get("brand")):
    nn=norm(t.get("name:en") or t.get("name"))
    if nn and len(nn)>=4:NOTABLE.setdefault(nn,[]).append(e)
# Последовательности слов известных мест: «Burj Al Arab» — начало «Burj Al
# Arab Jumeirah», «Madinat Jumeirah» — часть «Souk Madinat Jumeirah».
NOTABLE_SEQ=[]
WIKI_PTS=[]
for nn0,els in NOTABLE.items():
  for e in els:
    la=e.get("lat",e.get("center",{}).get("lat"));lo=e.get("lon",e.get("center",{}).get("lon"))
    NOTABLE_SEQ.append((nn0.split(),la,lo))
    if e["tags"].get("wikidata"):WIKI_PTS.append((la,lo,set(nn0.split())))
def contains_seq(big,small):
  k=len(small)
  return any(big[i:i+k]==small for i in range(len(big)-k+1))
def notable_shadow(nn,lat,lon):
  toks=nn.split()
  if len(toks)<2:return False
  for big,la,lo in NOTABLE_SEQ:
    if la is None:continue
    if contains_seq(big,toks) and dist(lat,lon,la,lo)>300:return True
  return False
OFFICE_LIKE={"tours","carrental","legal","courses","post","print","work","bank"}
def at_landmark_point(nn,lat,lon,tags=()):
  toks=set(nn.split())
  # Турагентство или прокат «в Burj Khalifa» в 100 м от центра башни — это
  # адрес-заглушка, а не офис. Обычным местам хватает 35 м.
  r=150 if OFFICE_LIKE&set(tags) else 35
  for la,lo,names in WIKI_PTS:
    if la is not None and abs(lat-la)<0.002 and abs(lon-lo)<0.002 and dist(lat,lon,la,lo)<r and not (toks&names):return True
  return False
def near_osm(lat,lon,name):
  n=norm(name)
  if not n:return None
  for dl in(-0.001,0,0.001):
    for dn in(-0.001,0,0.001):
      for e in grid.get((round(lat+dl,3),round(lon+dn,3)),[]):
        on=norm(e["tags"].get("name:en") or e["tags"].get("name"))
        if not on:continue
        el=e.get("lat",e.get("center",{}).get("lat"));eo=e.get("lon",e.get("center",{}).get("lon"))
        if dist(lat,lon,el,eo)>120:continue
        if on==n or (len(n)>=5 and (n in on or on in n)):return e
  return None
c=duckdb.connect()
hasn=os.path.exists(f"{S}/dubai_names.parquet")
rows=c.execute(f"""SELECT o.id,o.name,{"coalesce(list_filter(n.rules, x -> x.language='en' AND x.variant='language')[1].value, list_filter(n.rules, x -> x.language='en')[1].value)" if hasn else 'NULL'},cat,basic_category,cats_alt,confidence,websites,phones,socials,brand,brand_wikidata,addresses,lat,lon,operating_status
 FROM '{S}/dubai_overture.parquet' o {"LEFT JOIN '"+S+"/dubai_names.parquet' n ON n.id=o.id" if hasn else ""} WHERE confidence>=0.5 AND (operating_status IS NULL OR operating_status='open') ORDER BY confidence DESC""").fetchall()
# Точки, куда геокодер Overture складывает места без точного адреса
# («Downtown Dubai», «Bur Dubai»): десятки разных заведений в одной точке.
# Такие места показывали ложное «0.3 км от вас» — выбрасываем, если в этой
# точке нет торгового центра (там сотни магазинов стоят законно).
from collections import Counter
cc=Counter((round(r[13],4),round(r[14],4)) for r in rows)
MALLS=[(e.get("lat",e.get("center",{}).get("lat")),e.get("lon",e.get("center",{}).get("lon"))) for k,e in allosm.items() if e["tags"].get("shop") in("mall","department_store") or e["tags"].get("building") in("retail","commercial") and e["tags"].get("shop")]
def near_mall(la,lo):
  return any(abs(la-a)<0.002 and abs(lo-b)<0.002 for a,b in MALLS if a is not None)
DEFAULT_PTS={k for k,n in cc.items() if n>=10 and not near_mall(*k)}
print("точек-заглушек:",len(DEFAULT_PTS),"мест в них:",sum(cc[k] for k in DEFAULT_PTS),file=sys.stderr)
stats={"overture":len(rows),"merged":0,"added":0,"skipped":0,"nonlatin":0}
out={t:list(v) for t,v in osm.items()}
OVGRID={}
seen=set()
for (oid,name,name_en,cat,basic,alts,conf,webs,phones,socials,brand,bwd,addrs,lat,lon,status) in rows:
  LAT=re.compile(r"[A-Za-z]")
  nm=name_en if name_en and LAT.search(name_en) else name
  # Подрядчики и конторы под потребительской рубрикой: «Pool & Landscaping»,
  # «… Contracting LLC» в «бассейнах» — человеку туда не нужно.
  if nm and B2B_NAME.search(nm):stats["b2b"]=stats.get("b2b",0)+1;continue
  # «Dubai Watch Week 2025», «Expo 2020 Pavilion»: прошедшие события и выставки.
  if nm and re.search(r"\b20(?:1\d|2[0-5])\b",nm) and not re.search(r"\b(?:street|st|road|rd|building|tower|plot|office|shop|unit)\b",nm,re.I):stats["stale"]=stats.get("stale",0)+1;continue
  # Без латиницы название в англоязычном интерфейсе бесполезно (арабское,
  # персидское, «Пальма Джумейра»): берём бренд, если он латиницей, иначе пропуск.
  if nm and not LAT.search(nm):
    nm=brand if brand and LAT.search(brand) else None
    if not nm:stats["nonlatin"]=stats.get("nonlatin",0)+1;continue
  if not nm:stats["skipped"]+=1;continue
  tags=tags_for(cat,basic,nm,alts)
  if not tags:stats["skipped"]+=1;continue
  a=(addrs or [{}])[0] or {};addr=clean_addr(", ".join(x for x in[a.get("freeform"),a.get("locality")] if x))
  extra={}
  if phones:extra["phone"]=phones[0]
  if webs:extra["website"]=webs[0]
  if addr:extra["addr:full"]=addr
  if brand:extra["brand"]=brand
  if bwd:extra["brand:wikidata"]=bwd
  cu=cuisine_of([cat,*(alts or [])])
  if cu:extra["cuisine"]=cu
  hit=near_osm(lat,lon,nm)
  nn=norm(nm)
  if not hit and (round(lat,4),round(lon,4)) in DEFAULT_PTS:stats["default_geo"]=stats.get("default_geo",0)+1;continue
  # Место из другого эмирата или страны с координатами Дубая («Tamaseel Theatre
  # Lahore», «Piercing Abudhabi», «Ice Land Waterpark, Ras Al Khaimah»).
  if not hit and ELSEWHERE.search(nm+" "+addr):stats["elsewhere"]=stats.get("elsewhere",0)+1;continue
  if not hit:
    if nn in PLACE_NAMES or norm(nm.replace("The ","")) in PLACE_NAMES:stats["placename"]=stats.get("placename",0)+1;continue
    if nn in NOTABLE and not brand:stats["notable_dup"]=stats.get("notable_dup",0)+1;continue
    # Двойник известного места в другой точке («Burj Al Arab» в Порт-Саиде).
    if not brand and notable_shadow(nn,lat,lon):stats["notable_dup"]=stats.get("notable_dup",0)+1;continue
    # Геокодер положил место ровно в точку достопримечательности
    # («Liwa Desert Safari» в Burj Khalifa) — адреса у него на самом деле нет.
    if at_landmark_point(nn,lat,lon,tags):stats["landmark_pt"]=stats.get("landmark_pt",0)+1;continue
    # Тот же объект несколько раз в радиусе 150 м — оставляем самый надёжный.
    cell=(round(lat,3),round(lon,3));dup=False
    for dl in(-0.001,0,0.001):
      for dn in(-0.001,0,0.001):
        for (la,lo,n2) in OVGRID.get((round(lat+dl,3),round(lon+dn,3)),[]):
          if n2==nn and dist(lat,lon,la,lo)<=150:dup=True
    if dup:stats["near_dup"]=stats.get("near_dup",0)+1;continue
    OVGRID.setdefault(cell,[]).append((lat,lon,nn))
  if hit:
    for k,v in extra.items():
      # Бренд с Overture на найденное в OSM место не переносим: склейка по
      # имени и 120 м приклеила к Burj Khalifa бренд «OYO».
      if k in("brand","brand:wikidata"):continue
      if k=="addr:full" and any(hit["tags"].get(x) for x in("addr:street","addr:full")):continue
      if not hit["tags"].get(k) and not hit["tags"].get("contact:"+k):hit["tags"][k]=v
    hit["tags"]["source:overture"]=oid
    # OSM-место с одним арабским именем получает английское из Overture.
    if not hit["tags"].get("name:en") and not LAT.search(hit["tags"].get("name","")) and LAT.search(nm):hit["tags"]["name:en"]=nm
    stats["merged"]+=1
    for t in tags:
      if t in out and hit not in out[t] and (hit["type"],hit["id"]) not in seen:out[t].append(hit)
    continue
  ktag,kval=SYN.get(tags[0],("amenity","yes"))
  el={"type":"node","id":9_000_000_000_000+int(hashlib.sha1(oid.encode()).hexdigest()[:12],16)%10**12,"lat":lat,"lon":lon,
      "tags":{"name":nm,ktag:kval,"free:category":tags[0],"source":"overture","overture:category":"" if nm in NAMED_OVERRIDE else (cat or basic or ""),**extra}}
  for t in tags:out.setdefault(t,[]).append(el)
  stats["added"]+=1
json.dump(out,open(f"{S}/dubai_merged.json","w"))
print(json.dumps(stats))
for t in sorted(out,key=lambda t:-len(out[t]))[:90]:
  els=out[t];n=len(els) or 1
  ph=round(100*sum(1 for e in els if e["tags"].get("phone") or e["tags"].get("contact:phone"))/n)
  web=round(100*sum(1 for e in els if e["tags"].get("website") or e["tags"].get("contact:website"))/n)
  hrs=round(100*sum(1 for e in els if e["tags"].get("opening_hours"))/n)
  print(f"{t:14}{len(els):>7}  тел {ph:>3}%  сайт {web:>3}%  часы {hrs:>3}%")
