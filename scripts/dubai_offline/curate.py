"""Чистка карты Дубая после склейки OSM + Overture (вызывается из merge.py).

Правила здесь, ручные списки с источниками — в curated/*.json:
  closures.json  закрытые / временно закрытые / переименованные места
  seasons.json   сезонные места (free:season)
  fixes.json     ориентиры для проверки координат, ошибочные записи, недостающие места
  michelin.json  гид MICHELIN Dubai (free:michelin, free:price)
  awards.json    MENA's 50 Best Restaurants (free:award)
  hospitals_en.json  английские имена больниц с арабским названием

Теги для остальных частей FREE (договорённость, менять только вместе с сервером):
  free:status        "closed" (место выбрасывается при ingest) | "temporarily_closed"
  free:status_note   короткое пояснение по-английски
  free:status_src    ссылка на источник
  free:season        "MM-DD/MM-DD" (может переходить через год)
  free:michelin      "3 Stars" | "2 Stars" | "1 Star" | "Bib Gourmand" | "Selected"
  free:award         "MENA's 50 Best Restaurants 2026 #N"
  free:price         1..4, free:price_src — откуда цена
"""
import json,re,math,os,unicodedata,hashlib,sys
from collections import Counter,defaultdict

HERE=os.path.dirname(os.path.abspath(__file__))
CURATED=os.path.join(HERE,"curated")
def load(name):
  with open(os.path.join(CURATED,name),encoding="utf-8") as f:return json.load(f)

def dist(a,b,c,d):
  return 6371000*2*math.asin(math.sqrt(math.sin(math.radians(c-a)/2)**2+math.cos(math.radians(a))*math.cos(math.radians(c))*math.sin(math.radians(d-b)/2)**2))
def ll(e):
  return (e.get("lat",e.get("center",{}).get("lat")),e.get("lon",e.get("center",{}).get("lon")))
def fold(s):
  s=unicodedata.normalize("NFKD",str(s or "")).lower()
  return re.sub(r"[̀-ͯ]","",s)
def words(s):
  """Имя для сравнения: без диакритики и пунктуации, без «the»."""
  s=re.sub(r"[^a-z0-9؀-ۿ]+"," ",fold(s).replace("&"," and "))
  return " ".join(w for w in s.split() if w!="the")
LATIN=re.compile(r"[A-Za-z]")
def names_of(t):
  return [x for x in (t.get("name:en"),t.get("name"),t.get("brand"),t.get("alt_name"),t.get("alt_name:en"),t.get("int_name"),t.get("official_name:en")) if x]
def is_overture(e):return e["tags"].get("source")=="overture"
def is_curated(e):return e["tags"].get("source") in("free-curated","michelin")
def pid(e):return f'{e["type"]}/{e["id"]}'

# ---------------------------------------------------------------- границы
class Area:
  """Точка вне эмирата Дубай: внутри другого эмирата и дальше BUFFER_DEG от Дубая.
  Море (не внутри ни одного эмирата) — оставляем: Пальма, острова, Bluewaters."""
  # ≈30 м: погрешность границы и точек. Шире нельзя — по границе стоят ТЦ
  # Шарджи (Sahara Centre в 80 м от Дубая) со всем фудкортом.
  BUFFER_DEG=0.0003
  def __init__(self,S):
    p=f"{S}/boundaries.json"
    self.ok=os.path.exists(p)
    if not self.ok:print("ВНИМАНИЕ: нет boundaries.json — обрезки по эмирату не будет",file=sys.stderr);return
    B=json.load(open(p,encoding="utf-8"))
    self.dubai_name=next((k for k in B if k.lower().startswith("dubai")),None)
    try:
      from shapely.geometry import Polygon,MultiPolygon,Point
      from shapely.prepared import prep
      mp=lambda k:MultiPolygon([Polygon(x["outer"],x["holes"]) for x in B[k]["polygons"]]).buffer(0)
      self.Point=Point
      self.dubai=prep(mp(self.dubai_name).buffer(self.BUFFER_DEG))
      self.others=[(k,prep(mp(k))) for k in B if k!=self.dubai_name]
      self.mode="shapely"
    except ImportError:
      # Без shapely: луч через кольца; буфер — проверка соседних точек.
      self.mode="raycast"
      self.rings={k:[(x["outer"],x["holes"]) for x in v["polygons"]] for k,v in B.items()}
      self.bbox={k:[(min(p[0] for p in o),min(p[1] for p in o),max(p[0] for p in o),max(p[1] for p in o)) for o,_ in v] for k,v in self.rings.items()}
    self.cache={}
  @staticmethod
  def _in_ring(x,y,ring):
    inside=False;j=len(ring)-1
    for i in range(len(ring)):
      xi,yi=ring[i];xj,yj=ring[j]
      if (yi>y)!=(yj>y) and x<(xj-xi)*(y-yi)/((yj-yi) or 1e-12)+xi:inside=not inside
      j=i
    return inside
  def _in(self,k,lon,lat):
    for (o,holes),(a,b,c,d) in zip(self.rings[k],self.bbox[k]):
      if a<=lon<=c and b<=lat<=d and self._in_ring(lon,lat,o) and not any(self._in_ring(lon,lat,h) for h in holes):return True
    return False
  def outside(self,lat,lon):
    """Имя чужого эмирата или None."""
    if not self.ok or lat is None:return None
    key=(round(lat,5),round(lon,5))
    if key in self.cache:return self.cache[key]
    res=None
    if self.mode=="shapely":
      p=self.Point(lon,lat)
      if not self.dubai.contains(p):
        res=next((k for k,g in self.others if g.contains(p)),None)
    else:
      d=self.BUFFER_DEG
      if not any(self._in(self.dubai_name,lon+dx,lat+dy) for dx,dy in((0,0),(d,0),(-d,0),(0,d),(0,-d))):
        res=next((k for k in self.rings if k!=self.dubai_name and self._in(k,lon,lat)),None)
    self.cache[key]=res
    return res
ADDR_ELSEWHERE=re.compile(r"\b(sharjah|shj|ajman|umm al quwain|ras al khaimah|abu dhabi|al ain)\b|الشارقة|عجمان",re.I)

# ---------------------------------------------------------------- координаты
# Районы для сверки адреса с точкой: центр (из city.mjs через cats.json) и
# радиус района, км. Только однозначные названия: «Jumeirah» — и район, и сеть
# отелей, и улица на 15 км, поэтому его здесь нет.
DISTRICT_RADIUS={"Dubai Marina":2.5,"JBR":1.5,"Downtown Dubai":1.5,"DIFC":1.2,"Business Bay":2.5,"Palm Jumeirah":4,
  "JLT":1.5,"Al Barsha":3,"Deira":4,"Bur Dubai":3,"Alserkal Avenue":1,"Al Quoz":4,"City Walk":1,"La Mer":1.2,"Dubai Hills":2.5,
  "Al Seef":1.2,"Festival City":2,"Dubai Creek Harbour":2,"Al Karama":1.5,"Al Satwa":1.5,"Al Rigga":1.5,"Oud Metha":1.5,
  "Mirdif":3,"Dubai Silicon Oasis":2.5,"Motor City":2,"Dubai Sports City":2.5,"International City":2.5,"Discovery Gardens":1.5,
  "Al Qusais":3,"Jebel Ali":10,"Umm Suqeim":3,"Al Sufouh":3,"Dubai Media City":2.5,"Dubai Internet City":2.5,"Barsha Heights":1.5,
  "Umm Hurair":1.5,"Al Garhoud":2,"Al Mamzar":2,"Bluewaters":1,"Dubai Harbour":1.5,"Meydan":3,"Arabian Ranches":3,"JVC":2,
  "JVT":1.5,"Damac Hills":3,"Dubai Healthcare City":1.5,"Dubai Design District":1.2,"Al Jaddaf":2,"Mushrif":2.5,"Al Mankhool":1.5,
  "Dubai Investments Park":4,"Expo City":3}
# Для адресов регэкспы строже, чем в city.mjs (там — разбор запроса человека).
DISTRICT_ADDR_RE={"Dubai Marina":r"\bdubai marina\b|\bmarina walk\b|\bmarina promenade\b|\bpier 7\b","JBR":r"\bjbr\b|jumeira?h? beach residences?|\bthe walk\b",
  "Palm Jumeirah":r"\bpalm jumei?rah?\b|\bthe palm\b(?! jebel| deira)|\bcrescent road\b","Al Barsha":r"\bal barsha\b(?! south| heights)","Deira":r"\bdeira\b(?! islands?)",
  "Bur Dubai":r"\bbur dubai\b|\bal fahidi\b|\bmeena bazaar\b|\bbastakiya\b","Al Quoz":r"\bal quoz\b|\balserkal\b","Dubai Media City":r"\bmedia city\b(?!.*sharjah)",
  "Mirdif":r"\bmirdiff?\b","Jebel Ali":r"\bjebel ali\b|\bjafza\b","Business Bay":r"\bbusiness bay\b","Downtown Dubai":r"\bdowntown dubai\b",
  "Al Nahda":None,"Dubai Airport":None,"Jumeirah":None,"Al Wasl":None}
SEP_END=re.compile(r"(\s*[-–|@,(/]\s*|\s(at|in|near|opp\.?|opposite)\s)(the\s+)?$")
class Coast:
  """Береговая линия OSM (coast.json из extract.py): пляж — только у моря."""
  def __init__(self,S):
    p=f"{S}/coast.json";self.grid=defaultdict(list);self.ok=os.path.exists(p)
    if self.ok:
      for la,lo in json.load(open(p)):self.grid[(round(la,2),round(lo,2))].append((la,lo))
  def near(self,lat,lon,m=500):
    if not self.ok:return True
    for dl in(-0.01,0,0.01):
      for dn in(-0.01,0,0.01):
        for la,lo in self.grid.get((round(lat+dl,2),round(lon+dn,2)),()):
          if abs(la-lat)<0.006 and abs(lo-lon)<0.006 and dist(lat,lon,la,lo)<=m:return True
    return False
class Geo:
  MARGIN_KM=1.5
  def __init__(self,cfg,fixes):
    self.landmarks=[(re.compile(l["re"],re.I),tuple(l["at"]),float(l["radius_km"]),l["name"]) for l in fixes.get("landmarks",[])]
    self.districts=[]
    for d in cfg.get("districts",[]):
      r=DISTRICT_RADIUS.get(d["name"]);rx=DISTRICT_ADDR_RE.get(d["name"],d["re"])
      if r and rx:self.districts.append((re.compile(rx,re.I),(d["lat"],d["lon"]),r,d["name"]))
  def _hits(self,text,lat,lon,table):
    out=[]
    for rx,(la,lo),r,nm in table:
      if rx.search(text):out.append((nm,dist(lat,lon,la,lo)/1000,r))
    return out
  def landmark_in_name(self,name):
    """Ориентир в названии, если название — это он сам или «X - Ориентир»,
    «X at Ориентир», «X, Ориентир», «X (Ориентир)». «Wafi Gourmet» или «Global
    Village Restaurant» в другом районе — просто название, не адрес."""
    n=fold(name);end=len(re.sub(r"([\s,.-]*\b(dubai|uae|llc|l\.l\.c|branch)\b[\s.,]*)+$","",n))
    for rx,at,r,nm in self.landmarks:
      m=rx.search(n)
      if not m:continue
      rest=re.sub(r"\b(the|dubai|uae|jumeirah|branch|at|in|@)\b|[^a-z0-9]+"," ",n[:m.start()]+" "+n[m.end():]).strip()
      # «Starbucks Marina Walk», «Shake Shack Dubai Mall» — ориентир в конце
      # имени это филиал в нём.
      if not rest or SEP_END.search(n[:m.start()]) or m.end()>=end-1:
        yield (rx,at,r,nm)
  def districts_in_name(self,name):
    """Район в конце названия или после разделителя — это филиал в этом районе:
    «Hilton Downtown Dubai», «Canal Central Hotel Business Bay», «X - JLT»."""
    n=fold(name).strip();end=len(re.sub(r"([\s,.-]*\b(dubai|uae|llc|l\.l\.c|branch)\b[\s.,]*)+$","",n))
    for rx,at,r,nm in self.districts:
      for m in rx.finditer(n):
        if m.end()>=end-1 or SEP_END.search(n[:m.start()]):
          yield (rx,at,r,nm);break
  def verdict(self,name,addr,lat,lon):
    """'ok' — адрес или имя подтверждают точку, 'contra' — противоречат, 'unknown'."""
    a=fold(addr or "")
    # «Burj Khalifa Street», «Umm Suqeim Road», «Al Barsha Rd» — это улицы на
    # километры, а не районы и не сами места: из сверки их убираем.
    a=re.sub(r"\b(?:[a-z0-9']+ ){1,3}(?:st|street|rd|road)\b"," ",a)
    hits=self._hits(a,lat,lon,self.landmarks)+self._hits(a,lat,lon,self.districts)
    for rx,(la,lo),r,nm in [*self.landmark_in_name(name or ""),*self.districts_in_name(name or "")]:
      hits.append((nm,dist(lat,lon,la,lo)/1000,r))
    if not hits:return "unknown",None
    if any(km<=r+self.MARGIN_KM for nm,km,r in hits):return "ok",None
    return "contra",min(hits,key=lambda h:h[1]-h[2])[0]

# ---------------------------------------------------------------- рубрики
HOTEL_WORD=re.compile(r"\b(hotels?|resorts?|inn|suites|hostels?|motel|lodge|guest ?house|palace|apartments? hotel|hotel apartments?|aparthotel|residences? by|by [a-z]+ hotels?)\b",re.I)
RENTAL=re.compile(r"\boyo\b|holiday ?homes?|vacation|\bstudio\b|\bapartment\b(?! hotel)|\b\d+ ?(?:br|bed|beds|bedrooms?|bhk)\b|bedroom|penthouse|\bvillas?\b|luxury stays?|\bstays?\b|airbnb|\bbnb\b|\bnook\b|\bflat\b|\bfor rent\b|\brooms? for\b|\bbed ?space\b|\bpartition\b|keys ?please|frank porter|silkhaus|deluxe holiday|driven holiday|\bsea view\b|\bview\b|\baccomm?odations?\b|\blabou?r camp\b|\bbldg\b|\bbuilding\b|\btower\b(?! hotel)",re.I)
VENUE_IN_HOTEL=[("food",re.compile(r"\b(restaurant|grill|kitchen|bistro|brasserie|steak ?house|trattoria|pizzeria|sushi|dining|eatery|buffet|deli|tandoor|diner)\b",re.I)),
  ("bar",re.compile(r"\b(bar|lounge|pub|tavern|speakeasy|rooftop)\b",re.I)),("coffee",re.compile(r"\b(caf[eé]|coffee|tea ?room|patisserie|bakery)\b",re.I)),
  ("spa",re.compile(r"\b(spa|salon|hammam|wellness)\b",re.I)),("gym",re.compile(r"\b(gym|fitness|health club)\b",re.I)),("pool",re.compile(r"\b(pool)\b",re.I)),
  ("beach",re.compile(r"\bbeach club\b",re.I)),("club",re.compile(r"\b(night ?club)\b",re.I)),
  (None,re.compile(r"\b(ballroom|meeting|conference|catering|banquet|events? hall|parking|car park|laundry|reception|staff)\b",re.I))]
SEP=re.compile(r"\s[-–|@]\s|\s@|\bat\b|,|\(")
def hotel_fix(name,ocat):
  """Рубрика Overture «hotel/lodging/resort…» для места, которое на деле
  ресторан в отеле, квартира посуточно или жилой дом. Возвращает
  (новые_рубрики|None — оставить отель, причина)."""
  n=name or ""
  hw=HOTEL_WORD.search(n)
  for tag,rx in VENUE_IN_HOTEL:
    m=rx.search(n)
    # «Spice Island Restaurant Crowne Plaza» — ресторан; «Habtoor Grand Resort & Spa» — отель.
    if m and (not hw or m.start()<hw.start()):return ([tag] if tag else []),"venue_in_hotel"
  sp=SEP.search(n)
  if sp and not HOTEL_WORD.search(n[:sp.start()]) and HOTEL_WORD.search(n[sp.end():]):return [],"venue_in_hotel"
  if RENTAL.search(n) and not re.search(r"\bhotel\b",n,re.I):return [],"rental_or_building"
  if (ocat or "") in("lodging","cabin","bed_and_breakfast") and not hw:return [],"rental_or_building"
  return None,None
MALL_NAME=re.compile(r"\b(mall|centre|center|souk|souq|plaza|galleria|outlet|walk|village|square|boulevard|arcade|market|bazaar|emporium|avenue|wharf|pavilion|strip)\b",re.I)
BEACH_NAME=re.compile(r"\bbeach\b|\bplage\b|\bshore\b|\bcove\b|\blagoon\b|\bkite\b|\bsurf|\bnikki\b|zero gravity|\bbay\b",re.I)
NOT_BEACH=re.compile(r"\b(residences?|tower|towers|hotel|apartments?|walk|mall|building|bldg|road|street|st|hospital|clinic|school|villa|villas)\b",re.I)
CONCERT_OK=re.compile(r"music_venue|concert|jazz_and_blues|live_music",re.I)
EVENT_NAME=re.compile(r"#|\btour\b|\btickets?\b|\bpresents\b|\bfeat\.?\b|\b20\d\d\b",re.I)

# ---------------------------------------------------------------- структурные теги
# Python-копия osm_tags.mjs: какие рубрики даёт месту сам OSM-тег. Нужна, чтобы
# убрать место из рубрики — иначе ingest вернёт её по тегу (shop=department_store → mall).
CL=re.compile(r'\["([a-z:_]+)"([=~])"([^"]+)"\]')
def structural_filters(cfg):
  out=defaultdict(list)
  for c in cfg["cats"]:
    for f in c["osm"]:
      conds=[];ok=True
      for k,op,raw in CL.findall(f):
        if op=="~" and raw==".":conds.append((k,None));continue
        vals=re.sub(r"^\^\((.*)\)\$$",r"\1",raw) if op=="~" else raw
        if not re.match(r"^[a-z_|]+$",vals):ok=False;break
        conds.append((k,set(vals.split("|"))))
      if ok and conds:out[c["tag"]].append(conds)
  return out
def _has(t,k,vals):
  v=t.get(k)
  if v in(None,""):return False
  return vals is None or any(x.strip() in vals for x in str(v).split(";"))

# ---------------------------------------------------------------- часы
TR=re.compile(r"(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})")
NIGHT_CATS={"food","coffee","bar","club","hookah","pastry","bakery","karaoke"}
def bad_hours(v,cats):
  rs=[(int(a)*60+int(b),int(c)*60+int(d)) for a,b,c,d in TR.findall(str(v))]
  if not rs:return None
  if any(s==e for s,e in rs):return "zero-length window"
  if cats&NIGHT_CATS and all(s==0 and e<=15*60 for s,e in rs):return "only 00:00-early window"
  return None

# ---------------------------------------------------------------- сопоставление по правилу
class Matcher:
  def __init__(self,els):
    self.els=els
  def find(self,m):
    rx=re.compile(m["name"],re.I) if m.get("name") else None
    near=m.get("near");r=m.get("radius_m") or 0
    out=[]
    for e in self.els:
      if m.get("osm") and pid(e)!=m["osm"]:continue
      if rx and not any(rx.search(fold(x)) or rx.search(x) for x in names_of(e["tags"])):continue
      if near and r:
        la,lo=ll(e)
        if la is None or dist(near[0],near[1],la,lo)>r:continue
      out.append(e)
    return out

GENERIC=set("""parking public parking car park mosque masjid atm toilet toilets playground park pharmacy supermarket grocery restaurant cafe coffee shop
 bakery salon barber shop laundry tailor mobile shop hospital clinic gym pool swimming pool beach bus stop metro station tram stop""".split("\n")[0].split())
GENERIC|={"public parking","car park","coffee shop","swimming pool","bus stop","mobile shop","مسجد","مصلى","hotel","mall","store","building","tower","villa","cafeteria","bar","lounge","spa","shop"}
CONTACT_KEYS=("phone","contact:phone","website","contact:website","opening_hours","email","contact:email","cuisine","addr:full","addr:street","addr:housenumber",
  "addr:street:en","addr:city","name:en","brand","brand:wikidata","wikidata","description","free:michelin","free:award","free:price","free:price_src",
  "free:status","free:status_note","free:status_src","free:season","source:overture","overture:category","alt_name")
PHOTO_KEYS=("free:photo","free:photo_w","free:photo_h","free:photo_site")

class Curator:
  def __init__(self,S,cfg,norm):
    self.S=S;self.cfg=cfg;self.norm=norm
    self.area=Area(S)
    self.coast=Coast(S)
    self.fixes=load("fixes.json")
    self.geo=Geo(cfg,self.fixes)
    self.sf=structural_filters(cfg)
    self.stats=Counter()
    self.log=[]
  # --- рубрики по OSM-тегам
  def structural(self,t):
    return {c for c,fs in self.sf.items() if any(all(_has(t,k,v) for k,v in conds) for conds in fs)}
  def neutralize(self,e,cat):
    """Убрать у места OSM-тег, который сам по себе даёт рубрику cat."""
    t=e["tags"]
    for conds in self.sf.get(cat,[]):
      if all(_has(t,k,v) for k,v in conds):
        k=conds[0][0];t["free:was:"+k]=t.pop(k)
  # --- главный проход
  def run(self,out):
    # Ключ — «тип/id». Одно OSM-место приходит отдельной копией в каждой своей
    # рубрике (JSON не хранит общие ссылки), а контакты из Overture merge.py
    # дописал только в одну из копий: склеиваем теги копий в одно место.
    reg={}                                   # pid → место
    cats=defaultdict(set)                    # pid → рубрики
    for c,els in out.items():
      for e in els:
        k=pid(e)
        if k in reg and reg[k] is not e:
          for kk,v in e["tags"].items():reg[k]["tags"].setdefault(kk,v)
        else:reg[k]=e
        cats[k].add(c)
    self.reg=reg;self.cats=cats
    drop=set()
    def kill(e,why):
      if pid(e) not in drop:drop.add(pid(e));self.stats["drop:"+why]+=1;self.log.append((why,pid(e),e["tags"].get("name:en") or e["tags"].get("name")))
    # 1. Вне Дубая: точка в другом эмирате (кроме полосы 150 м у границы) или
    # адрес в Шардже/Аджмане у места рядом с границей.
    for k,e in reg.items():
      la,lo=ll(e)
      if self.area.outside(la,lo):kill(e,"out_of_area");continue
      t=e["tags"]
      city=" ".join(str(t.get(x,"")) for x in("addr:city","addr:city:en","is_in"))
      if re.search(r"sharjah|ajman|الشارقة|عجمان",city,re.I) and la is not None and la>25.22 and lo>55.33:kill(e,"addr_city_sharjah")
    # 2. Ошибочные записи из fixes.json и закрытые места.
    alive=lambda:[e for k,e in reg.items() if k not in drop]
    M=Matcher(alive())
    for r in self.fixes.get("drop",[]):
      for e in M.find(r["match"]):kill(e,"curated_wrong")
    for r in load("closures.json")["rules"]:
      hits=Matcher(alive()).find(r["match"])
      if not hits:self.log.append(("closure_unmatched",r["match"].get("name"),""))
      for e in hits:
        t=e["tags"]
        if r.get("rename"):
          old=t.get("name:en") or t.get("name")
          t["name"]=r["rename"];t["name:en"]=r["rename"];t["old_name"]=old
          t["free:status_note"]=r["note"];t["free:status_src"]=r["src"];self.stats["renamed"]+=1;continue
        t["free:status"]=r["status"];t["free:status_note"]=r["note"];t["free:status_src"]=r["src"]
        self.stats["status:"+r["status"]]+=1
        if r["status"]=="closed":kill(e,"closed_curated")
    for r in load("seasons.json")["rules"]:
      for e in Matcher(alive()).find(r["match"]):
        e["tags"]["free:season"]=r["season"];e["tags"]["free:status_note"]=r["note"];e["tags"]["free:status_src"]=r["src"];self.stats["season"]+=1
    for r in self.fixes.get("set",[]):
      hits=Matcher(alive()).find(r["match"])
      if not hits:self.log.append(("set_unmatched",r["match"].get("name"),""))
      for e in hits:
        for k2,v in r.get("tags",{}).items():e["tags"].setdefault(k2,v)
        cats[pid(e)]|=set(r.get("cats",[]))
    # 3. OSM-«двойники» известных мест: имя как у места с wikidata, но в 2+ км
    # от него, без сайта и телефона («Rashid hospital» в Мирдифе), или имя
    # с ориентиром, который в другой части города («jumairah beach burj al arab»).
    NOTABLE_CATS={"hotel","sights","museum","themepark","zoo","aquapark","beach","hospital","mall","park","gallery","theatre"}
    wiki=defaultdict(list)
    for k,e in reg.items():
      t=e["tags"]
      if t.get("wikidata") and not is_overture(e):wiki[words(t.get("name:en") or t.get("name"))].append(ll(e))
    for k,e in list(reg.items()):
      if k in drop or is_overture(e) or is_curated(e):continue
      t=e["tags"]
      if t.get("wikidata") or t.get("website") or t.get("contact:website") or t.get("phone") or t.get("contact:phone") or t.get("brand"):continue
      if not cats[k]&NOTABLE_CATS:continue
      nm=t.get("name:en") or t.get("name") or "";w=words(nm);la,lo=ll(e)
      if not w:continue
      if w in wiki and all(dist(la,lo,a,b)>2000 for a,b in wiki[w]):kill(e,"osm_shadow");continue
      for rx,at,r,lname in self.geo.landmark_in_name(nm):
        if dist(la,lo,at[0],at[1])/1000>r+self.geo.MARGIN_KM:kill(e,"osm_shadow");break
    # 4. Рубрики: отели, ТЦ, пляжи, концерты.
    for k,e in reg.items():
      if k in drop:continue
      t=e["tags"];nm=t.get("name:en") or t.get("name") or ""
      if is_overture(e):continue                      # Overture разобран в merge.py
      if "mall" in cats[k]:
        if t.get("shop")=="department_store" and not re.search(r"\bmall\b",nm,re.I):
          self.neutralize(e,"mall");cats[k].discard("mall");cats[k].add("clothes");self.stats["mall→clothes"]+=1
        elif t.get("shop")=="mall" and not (MALL_NAME.search(nm) or t.get("wikidata") or t.get("website")):
          self.neutralize(e,"mall");cats[k].discard("mall");self.stats["mall_not_mall"]+=1
          if not cats[k]:kill(e,"not_a_mall")
      if "beach" in cats[k] and not (t.get("natural")=="beach" or t.get("leisure")=="beach_resort"):
        cats[k].discard("beach")
    # 5. Больницы: английское имя у места с арабским.
    hosp_en=load("hospitals_en.json")["names"]
    ov_h=[e for k,e in reg.items() if k not in drop and is_overture(e) and "hospital" in cats[k]]
    for k,e in reg.items():
      if k in drop or "hospital" not in cats[k]:continue
      t=e["tags"]
      if LATIN.search(t.get("name:en") or "") or LATIN.search(t.get("name") or ""):continue
      en=next((t[x] for x in("int_name","official_name:en","alt_name:en","name:en") if LATIN.search(t.get(x) or "")),None)
      if not en:en=hosp_en.get((t.get("name") or "").strip())
      if not en:
        la,lo=ll(e)
        near=[o for o in ov_h if dist(la,lo,*ll(o))<200]
        if near:en=near[0]["tags"]["name"]
      # «Al Bada'a Health Center | مركز البدع الصحي» → латинская часть.
      if en:en=re.sub(r"\s{2,}"," ",re.sub(r"[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+"," ",en)).strip(" |-–,/()")
      if en and LATIN.search(en):t["name:en"]=en;self.stats["hospital_name_en"]+=1
    # 6. Часы: заведомо битые значения убираем, а не показываем ложное «открыто».
    for k,e in reg.items():
      if k in drop:continue
      v=e["tags"].get("opening_hours")
      if v:
        why=bad_hours(v,cats[k])
        if why:e["tags"]["free:bad_hours"]=v;del e["tags"]["opening_hours"];self.stats["hours_dropped:"+why]+=1
    # 7. Недостающие известные места.
    for a in self.fixes.get("add",[]):
      el={"type":"node","id":9_200_000_000_000+int(hashlib.sha1(a["id"].encode()).hexdigest()[:12],16)%10**12,"lat":a["lat"],"lon":a["lon"],
          "tags":{"name":a["name"],"name:en":a["name"],**a["tags"],"source":"free-curated","source:ref":a["src"],"free:category":a["cats"][0]}}
      reg[pid(el)]=el;cats[pid(el)]=set(a["cats"]);self.stats["added_curated"]+=1
    # 8. MICHELIN и 50 Best.
    self.michelin(reg,cats,drop)
    self.awards(reg,cats,drop)
    # 9. Дубли: одно имя в пределах 150 м — одно место.
    self.dedupe(reg,cats,drop)
    # 10. Метро и трамвай: понятное английское имя.
    for k,e in reg.items():
      if k in drop or "metro" not in cats[k]:continue
      t=e["tags"];base=t.get("name:en") or t.get("name") or ""
      kind="Tram Station" if t.get("railway")=="tram_stop" else "Metro Station"
      if LATIN.search(base) and not re.search(r"\b(station|stop)\b",base,re.I):t["name:en"]=f"{base} {kind}"
      self.stats["metro"]+=1
    new=defaultdict(list)
    for k,e in reg.items():
      if k in drop:continue
      for c in cats[k]:new[c].append(e)
    for c in out:new.setdefault(c,[])
    return dict(new)
  # --- MICHELIN
  def michelin(self,reg,cats,drop):
    data=load("michelin.json");edition=data["edition"]
    FOODISH={"food","bar","coffee","club","hookah","pastry","bakery","karaoke"}
    alive=[(k,e) for k,e in reg.items() if k not in drop]
    by_words=defaultdict(list)
    for k,e in alive:
      for x in names_of(e["tags"]):by_words[words(x)].append((k,e))
    def mw(s):
      s=words(s);s=re.sub(r"\b(dubai|restaurant|by [a-z ]+)$","",s).strip()
      return s or words(s)
    for r in data["restaurants"]:
      dist_=r["distinction"];key=mw(r["name"])
      cand=[]
      if r.get("lat") is not None:
        for k,e in alive:
          la,lo=ll(e)
          if la is None or abs(la-r["lat"])>0.006 or abs(lo-r["lon"])>0.006:continue
          if dist(la,lo,r["lat"],r["lon"])>500:continue
          ws=[mw(x) for x in names_of(e["tags"])]
          if any(w==key or w.replace(" ","")==key.replace(" ","") or (len(key)>=4 and re.search(r"(^| )"+re.escape(key)+r"( |$)",w))
                 or (len(w)>=5 and re.search(r"(^| )"+re.escape(w)+r"( |$)",key)) or (len(w)>=4 and key.startswith(w+" ")) for w in ws if w):
            cand.append((k,e))
      if not cand:
        ex=[(k,e) for k,e in by_words.get(words(r["name"]),[]) if cats[k]&FOODISH]
        if len(ex)==1 or (ex and r.get("lat") is None and len({(round(ll(e)[0],3),round(ll(e)[1],3)) for k,e in ex})==1):cand=ex
      if cand:
        for k,e in cand:self._tag_michelin(e,r,edition);cats[k]|={"food"} if not cats[k]&FOODISH else set()
        self.stats["michelin_matched"]+=1
      elif r.get("lat") is not None and r.get("add",True):
        el={"type":"node","id":9_300_000_000_000+int(hashlib.sha1(r["url"].encode()).hexdigest()[:12],16)%10**12,"lat":r["lat"],"lon":r["lon"],
            "tags":{"name":r["name"],"name:en":r["name"],"amenity":"restaurant","source":"michelin","source:ref":r["url"],"free:category":"food"}}
        for k2,src in(("phone","phone"),("website","website"),("addr:full","address")):
          if r.get(src):el["tags"][k2]=r[src]
        if r.get("cuisine"):el["tags"]["cuisine"]=";".join(re.sub(r"[^a-z]+","_",fold(x).strip()).strip("_") for x in re.split(r",|/",r["cuisine"]) if x.strip())
        self._tag_michelin(el,r,edition)
        reg[pid(el)]=el;cats[pid(el)]={"food"};self.stats["michelin_added"]+=1
      else:self.log.append(("michelin_unmatched",r["name"],dist_))
  def _tag_michelin(self,e,r,edition):
    t=e["tags"];t["free:michelin"]=r["distinction"];t["free:michelin_src"]=r.get("url") or edition["src"]
    if r["distinction"] in("1 Star","2 Stars","3 Stars"):t["free:price"]="4";t["free:price_src"]="michelin"
    if r.get("website") and not (t.get("website") or t.get("contact:website")):t["website"]=r["website"]
    if r.get("phone") and not (t.get("phone") or t.get("contact:phone")):t["phone"]=r["phone"]
  def awards(self,reg,cats,drop):
    data=load("awards.json")
    for lst in data["lists"]:
      for it in lst["entries"]:
        keys={words(x) for x in [it["name"],*it.get("names",[])]}
        def ok(x,e):
          w=words(x)
          return w in keys or any(w==k+" dubai" or (w.startswith(k+" ") and e["tags"].get("free:michelin")) for k in keys)
        hits=[(k,e) for k,e in reg.items() if k not in drop and cats[k]&{"food","bar","coffee","club"} and any(ok(x,e) for x in names_of(e["tags"]))]
        mi=[h for h in hits if h[1]["tags"].get("free:michelin")]
        # Несколько совпадений — одно место (OSM + Overture до склейки дублей),
        # если все в 300 м друг от друга; иначе сеть, и какое из мест в рейтинге — не знаем.
        same=hits and all(dist(*ll(hits[0][1]),*ll(e))<300 for k,e in hits)
        pick=mi or (hits if same else [])
        if not pick:self.log.append(("award_unmatched",it["name"],len(hits)));continue
        for k,e in pick:e["tags"]["free:award"]=f'{lst["title"]} #{it["rank"]}';e["tags"]["free:award_src"]=lst["src"]
        self.stats["award"]+=1
  # --- дубли
  def dedupe(self,reg,cats,drop):
    keyof={}
    grid=defaultdict(list)
    for k,e in reg.items():
      if k in drop or "parking" in cats[k]:continue
      t=e["tags"]
      # Все имена места: в OSM name и name:en иногда разные («Cinque» / «Quattro Passi»),
      # и без пробелов («3 Fils» = «3Fils»).
      ns={self.norm(x) for x in(t.get("name:en"),t.get("name"),t.get("brand") if not(t.get("name") or t.get("name:en")) else None) if x}
      ns={n.replace(" ","") for n in ns if len(n)>=3 and n not in GENERIC}
      la,lo=ll(e)
      if not ns or la is None:continue
      keyof[k]=ns;grid[(round(la,3),round(lo,3))].append(k)
    parent={}
    def find(x):
      while parent.get(x,x)!=x:x=parent[x]
      return x
    for k,n in keyof.items():
      la,lo=ll(reg[k])
      for dl in(-0.004,-0.003,-0.002,-0.001,0,0.001,0.002,0.003,0.004):
        for dn in(-0.004,-0.003,-0.002,-0.001,0,0.001,0.002,0.003,0.004):
          if (abs(dl)>0.001 or abs(dn)>0.001) and not cats[k]&{"beach","park"}:continue
          for j in grid.get((round(la+dl,3),round(lo+dn,3)),[]):
            if j<=k or not (keyof[j]&n):continue
            a,b=reg[k]["tags"],reg[j]["tags"];d=dist(la,lo,*ll(reg[j]))
            # Два филиала в одном квартале с разными номерами домов — разные места
            # («M/G -4» и «MG 4», «3» и «Building 3» — один и тот же номер).
            ha,hb=re.sub(r"\D","",a.get("addr:housenumber") or ""),re.sub(r"\D","",b.get("addr:housenumber") or "")
            if ha and hb and ha!=hb and d>30:continue
            # Пляж и парк тянутся на сотни метров: «Kite Beach» OSM и Overture в 240 м.
            lim=400 if cats[k]&cats[j]&{"beach","park"} else 150
            if d<=lim:parent[find(j)]=find(k)
    groups=defaultdict(list)
    for k in keyof:groups[find(k)].append(k)
    def score(k):
      e=reg[k];t=e["tags"]
      return ((0 if is_overture(e) else 3)+(1 if e["type"]!="node" else 0)+(5 if t.get("free:michelin") else 0)+(3 if t.get("wikidata") else 0)
              +sum(1 for x in("phone","contact:phone","website","contact:website","opening_hours","addr:street","addr:full","cuisine") if t.get(x))+(1 if t.get("free:photo") else 0))
    def merge_into(w,l,why):
      wt,lt=reg[w]["tags"],reg[l]["tags"]
      # Другое написание имени не теряем: поиск по снимку видит name и name:en,
      # и «3Fils» после склейки с «3 Fils» должен находиться по-прежнему.
      ln=lt.get("name:en") or lt.get("name") or ""
      if not wt.get("name:en") and LATIN.search(ln) and words(ln)!=words(wt.get("name")):wt["name:en"]=ln
      for x in CONTACT_KEYS:
        if lt.get(x) and not wt.get(x) and not (x=="phone" and wt.get("contact:phone")) and not (x=="website" and wt.get("contact:website")):wt[x]=lt[x]
      if lt.get("free:photo") and not wt.get("free:photo"):
        for x in PHOTO_KEYS:
          if lt.get(x):wt[x]=lt[x]
      cats[w]|=cats[l];drop.add(l);self.stats[why]+=1
      self.log.append((why,pid(reg[w]),f'{wt.get("name:en") or wt.get("name")} <= {pid(reg[l])} {lt.get("name:en") or lt.get("name")} {round(dist(*ll(reg[w]),*ll(reg[l])))}m {"ov" if is_overture(reg[l]) else "osm"}'))
    for g,ks in groups.items():
      if len(ks)<2:continue
      ks.sort(key=lambda k:-score(k))
      for l in ks[1:]:merge_into(ks[0],l,"dedupe_merged")
    # Отель из Overture рядом с отелем OSM под чуть другим именем
    # («Mövenpick Jumeirah Lakes Towers» и «Mövenpick Hotel Jumeirah Lakes Towers»).
    STOP=set("""hotel hotels resort resorts spa and the by dubai apartments apartment hotel suites suite residence residences inn of at llc
      collection autograph beach grand premium luxury royal plaza palace golden new view star deluxe boutique express aparthotel""".split())
    # Район в имени отеля не делает его тем же отелем: «Ibis Deira City Centre»
    # и «Novotel Deira City Centre» — соседи. Нужно общее слово кроме района.
    LOC=set("""deira city centre center marina jumeirah jumeira barsha heights downtown business bay mall emirates palm jbr creek airport
      media internet sheikh zayed road tower towers gate square avenue garden gardens park lake lakes jlt dip sports silicon oasis
      festival healthcare karama bur rigga garhoud quoz mina seyahi satwa wasl hills harbour meydan sufouh nahda qusais muraqabat
      mankhool trade centre world dubailand motor village circle""".split())
    tok=lambda s:{w for w in words(s).split() if len(w)>=3 and w not in STOP}
    def same_hotel(a,b):
      return b and len(a&b)/len(a|b)>=0.5 and (a-LOC)&(b-LOC)
    osm_h=defaultdict(list)
    for k,e in reg.items():
      if k not in drop and "hotel" in cats[k] and not is_overture(e):
        la,lo=ll(e)
        if la is not None:osm_h[(round(la,2),round(lo,2))].append(k)
    for k,e in list(reg.items()):
      if k in drop or "hotel" not in cats[k] or not is_overture(e):continue
      a=tok(e["tags"].get("name"));la,lo=ll(e)
      if not a:continue
      best=None
      for dl in(-0.01,0,0.01):
        for dn in(-0.01,0,0.01):
          for j in osm_h.get((round(la+dl,2),round(lo+dn,2)),[]):
            if j in drop:continue
            if any(same_hotel(a,b) for b in map(tok,names_of(reg[j]["tags"]))) and dist(la,lo,*ll(reg[j]))<=250:best=j
      if best:merge_into(best,k,"hotel_fuzzy_merged")
