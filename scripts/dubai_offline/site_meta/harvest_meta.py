# Данные для решения «идти или нет» с собственных сайтов заведений:
# schema.org (JSON-LD и простая microdata) — часы, цены, кухня, меню,
# телефон, адрес, координаты; ссылки онлайн-брони (SevenRooms, OpenTable,
# Eat App…) и меню. Только то, что сайт сам открыто публикует.
#
# Вежливо: robots.txt для каждого запрашиваемого пути (RFC 9309: 4xx — можно,
# 5xx/недоступен — нельзя), не больше 2 запросов к одному хосту одновременно,
# таймаут 15 с, не больше 400 КБ со страницы, кроме главной — не больше двух
# страниц того же сайта (бронь, меню, контакты).
#
# Запуск (возобновляемый — уже записанные сайты пропускаются):
#   nohup nice -n 10 python3 harvest_meta.py --db osm_dubai.new.db \
#     --out photos/site_meta.jsonl --check photos/site_check.json > ws4b/harvest.log 2>&1 &
# Остановка — SIGTERM по PID: дописываем начатые сайты и выходим.
import argparse,html as HTML,json,os,re,signal,sqlite3,sys,threading,time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor,wait,FIRST_COMPLETED
from urllib.parse import urljoin,urlparse,parse_qs
from urllib import robotparser
import requests

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
BOT="FreeConciergeBot"  # имя для правил robots.txt (кроме «*»)
H={"User-Agent":UA,"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Accept-Language":"en-US,en;q=0.9"}
TIMEOUT=15;MAX_BYTES=400_000;DEADLINE=30;PER_HOST=2;MAX_SUB=2
SKIP_HOST=re.compile(r"(^|\.)(google\.[a-z.]+|goo\.gl|facebook\.com|fb\.com|fb\.me|instagram\.com|wa\.me|whatsapp\.com|t\.me|tiktok\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|snapchat\.com|linktr\.ee|bit\.ly|linkedin\.com|tripadvisor\.[a-z.]+|booking\.com|talabat\.com|deliveroo\.[a-z.]+|zomato\.com)$",re.I)
PARKED=re.compile(r"(domain (?:is )?for sale|buy this domain|this domain (?:may be|is) for sale|hugedomains|sedoparking|parkingcrew|domain has expired|this domain has expired|undeveloped\.com|domain parking)",re.I)

# ---------- schema.org ----------
VENUE=set("""LocalBusiness FoodEstablishment Restaurant FastFoodRestaurant CafeOrCoffeeShop BarOrPub Bakery IceCreamShop Brewery Winery Distillery
Hotel LodgingBusiness Resort Hostel Motel BedAndBreakfast Campground VacationRental TouristAttraction TouristDestination Museum Zoo Aquarium AmusementPark
Park Beach LandmarksOrHistoricalBuildings PlaceOfWorship HealthAndBeautyBusiness DaySpa BeautySalon HairSalon NailSalon TattooParlor
SportsActivityLocation ExerciseGym HealthClub GolfCourse SportsClub StadiumOrArena PublicSwimmingPool BowlingAlley SkiResort
EntertainmentBusiness NightClub MovieTheater ComedyClub ArtGallery Casino AdultEntertainment PerformingArtsTheater EventVenue
Store ShoppingCenter ClothingStore BookStore ElectronicsStore JewelryStore GroceryStore ConvenienceStore DepartmentStore FurnitureStore
MedicalBusiness MedicalClinic Dentist Pharmacy Optician Physician Hospital ChildCare AutomotiveBusiness AutoRental AutoRepair
TravelAgency FinancialService BankOrCreditUnion ProfessionalService RealEstateAgent EmergencyService""".split())
NOT_VENUE=set("Event Offer AggregateOffer Product Review AggregateRating WebSite WebPage BreadcrumbList ListItem ImageObject VideoObject Article BlogPosting NewsArticle Person SearchAction FAQPage Question Answer HowTo Recipe".split())
DATA_KEYS=("openingHours","openingHoursSpecification","priceRange","servesCuisine","hasMenu","menu","acceptsReservations")

def _s(v,lim=300):
  if v is None:return None
  if isinstance(v,(list,tuple)):v=next((x for x in v if isinstance(x,(str,int,float))),None) if v else None
  if isinstance(v,dict):v=v.get("name") or v.get("@value") or v.get("url") or v.get("@id")
  if v is None or isinstance(v,(dict,list)):return None
  v=HTML.unescape(str(v)).strip()
  return v[:lim] if v else None
def _types(d):
  t=d.get("@type") or d.get("type")
  if isinstance(t,str):t=[t]
  if not isinstance(t,list):return []
  return [str(x).rsplit("/",1)[-1] for x in t if isinstance(x,str)]
def _addr(a):
  if isinstance(a,str):return HTML.unescape(a).strip()[:300] or None
  if isinstance(a,list):a=a[0] if a else None
  if isinstance(a,dict):
    parts=[_s(a.get(k)) for k in ("streetAddress","addressLocality","addressRegion","postalCode","addressCountry")]
    s=", ".join(p for p in parts if p)
    return s[:300] or None
  return None
def _geo(g):
  if isinstance(g,list):g=g[0] if g else None
  if not isinstance(g,dict):return None
  try:
    la=float(str(g.get("latitude")).strip());lo=float(str(g.get("longitude")).strip())
    if -90<=la<=90 and -180<=lo<=180 and (la or lo):return [round(la,6),round(lo,6)]
  except Exception:pass
  return None
def _list(v):
  if v is None:return []
  return v if isinstance(v,list) else [v]
def _ohs(v):
  out=[]
  for s in _list(v)[:40]:
    if not isinstance(s,dict):continue
    dow=[str(x).rsplit("/",1)[-1] for x in _list(s.get("dayOfWeek")) if isinstance(x,(str,dict))]
    dow=[x if isinstance(x,str) else "" for x in dow]
    o={"dayOfWeek":dow,"opens":_s(s.get("opens"),20),"closes":_s(s.get("closes"),20)}
    for k in ("validFrom","validThrough"):
      if s.get(k):o[k]=_s(s.get(k),30)
    out.append(o)
  return out
def _menu(v,base):
  out=[]
  for m in _list(v)[:5]:
    u=None
    if isinstance(m,str):u=m
    elif isinstance(m,dict):u=m.get("url") or m.get("@id")
    if isinstance(u,str) and u.strip():
      u=urljoin(base,u.strip())
      if u.startswith("http"):out.append(u)
  return out
def entity(d,page):
  e={"type":_types(d)[:4],"src":page}
  for k,v in (("name",_s(d.get("name"))),("url",_s(d.get("url"))),("id",_s(d.get("@id"))),("telephone",_s(d.get("telephone"),60)),
              ("address",_addr(d.get("address"))),("geo",_geo(d.get("geo"))),("priceRange",_s(d.get("priceRange"),60))):
    if v:e[k]=v
  oh=d.get("openingHours")
  if oh:
    oh=[HTML.unescape(str(x)).strip()[:200] for x in _list(oh) if isinstance(x,(str,int))]
    if oh:e["openingHours"]=oh[:14]
  ohs=_ohs(d.get("openingHoursSpecification"))
  if ohs:e["openingHoursSpecification"]=ohs
  sc=[HTML.unescape(str(x)).strip()[:60] for x in _list(d.get("servesCuisine")) if isinstance(x,str) and x.strip()]
  if sc:e["servesCuisine"]=sc[:8]
  mn=_menu(d.get("hasMenu"),page)+_menu(d.get("menu"),page)
  if mn:e["menu"]=mn[:3]
  ar=d.get("acceptsReservations")
  if ar is not None and not isinstance(ar,(dict,list)):e["acceptsReservations"]=str(ar)[:300]
  sa=[x for x in _list(d.get("sameAs")) if isinstance(x,str)]
  if sa:e["sameAs"]=sa[:8]
  return e if any(k in e for k in ("name","geo","address","telephone","priceRange","openingHours","openingHoursSpecification","servesCuisine","menu")) else None
def walk(node,page,ents,actions,depth=0):
  if depth>12:return
  if isinstance(node,list):
    for x in node[:400]:walk(x,page,ents,actions,depth+1)
    return
  if not isinstance(node,dict):return
  ts=set(_types(node))
  if "ReserveAction" in ts or "OrderAction" in ts:
    tg=node.get("target")
    for t in _list(tg):
      u=t if isinstance(t,str) else (t.get("urlTemplate") or t.get("url")) if isinstance(t,dict) else None
      if isinstance(u,str):actions.append(("ReserveAction" in ts and "reserve" or "order",urljoin(page,u.strip())))
  if (ts&VENUE or (any(k in node for k in DATA_KEYS) and not ts&NOT_VENUE)) and not ts&NOT_VENUE:
    e=entity(node,page)
    if e and len(ents)<200:ents.append(e)
  for k,v in node.items():
    if isinstance(v,(dict,list)) and k not in ("review","reviews","aggregateRating","image","logo","offers","author","publisher","breadcrumb"):
      walk(v,page,ents,actions,depth+1)

LD=re.compile(r"<script\b[^>]*application/ld\+json[^>]*>(.*?)</script>",re.I|re.S)
def jsonld(html,page):
  ents=[];actions=[]
  for m in LD.finditer(html):
    raw=m.group(1).strip()
    raw=re.sub(r"^\s*(<!--|//\s*<!\[CDATA\[|<!\[CDATA\[)","",raw);raw=re.sub(r"(-->|//\s*\]\]>|\]\]>)\s*$","",raw).strip()
    d=None
    for attempt in (raw,re.sub(r",\s*([}\]])",r"\1",raw)):
      try:d=json.loads(attempt,strict=False);break
      except Exception:continue
    if d is None:continue
    walk(d,page,ents,actions)
  return ents,actions
MD_TYPE=re.compile(r"itemtype\s*=\s*[\"']https?://schema\.org/(\w+)[\"']",re.I)
def microdata(html,page):
  ts=[t for t in MD_TYPE.findall(html) if t in VENUE]
  if not ts:return None
  e={"type":ts[:2],"src":page,"md":True}
  def props(name):
    vals=[]
    for m in re.finditer(r"<(\w+)\b[^>]*\bitemprop\s*=\s*[\"']"+name+r"[\"'][^>]*>",html,re.I):
      tag=m.group(0);c=re.search(r"\b(?:content|datetime)\s*=\s*[\"']([^\"']*)[\"']",tag,re.I)
      if c:v=c.group(1)
      else:
        rest=html[m.end():m.end()+300];v=re.sub(r"<[^>]+>"," ",rest.split("</"+m.group(1),1)[0])
      v=re.sub(r"\s+"," ",HTML.unescape(v)).strip()
      if v:vals.append(v[:200])
      if len(vals)>=14:break
    return vals
  for k in ("name","telephone","priceRange"):
    v=props(k)
    if v:e[k]=v[0]
  oh=props("openingHours")
  if oh:e["openingHours"]=oh
  sc=props("servesCuisine")
  if sc:e["servesCuisine"]=sc[:8]
  return e if len(e)>3 else None

# ---------- ссылки: бронь и меню ----------
BOOK_TXT=re.compile(r"^\W*(?:book(?: a| your)?(?: table| now| online| a treatment| an? appointment| appointment| a session| a class| tickets?| here)?|reserve(?: a| your)?(?: table| now| online)?|reservations?|make a (?:reservation|booking)|table (?:booking|reservations?)|online (?:booking|reservations?)|booking)\W*$",re.I)
BOOK_PATH=re.compile(r"/(?:reserv\w*|book(?:ing|-a-table|-table|-now|atable|now)?|table-booking|tablebooking)(?:[/?#.]|$)",re.I)
MENU_TXT=re.compile(r"\bmenus?\b",re.I)
MENU_BAD_TXT=re.compile(r"\b(?:toggle|open|close|main|mobile|skip|navigation|nav|hamburger)\b",re.I)
MENU_PATH=re.compile(r"(?:^|[/_-])menus?(?:[/_.\-?#]|$)",re.I)
CONTACT=re.compile(r"contact|location|find[-\s]us|visit[-\s]us",re.I)
A_TAG=re.compile(r"<a\b([^>]*)>(.*?)</a\s*>",re.I|re.S)
ATTR=lambda tag,name:(lambda m:HTML.unescape(m.group(2)).strip() if m else None)(re.search(r"\b"+name+r"\s*=\s*([\"'])(.*?)\1",tag,re.I|re.S))
TAGS=re.compile(r"<[^>]+>")
RAW_URL=re.compile(r"https?:(?:\\?/){2}[a-z0-9.-]*(?:sevenrooms\.com|opentable\.[a-z.]+|eatapp\.co|eat-app\.[a-z.]+|tablecheck\.com|resy\.com|quandoo\.[a-z.]+|resdiary\.com|chope\.co|thefork\.[a-z.]+|dineplan\.com|feverup\.com|platinumlist\.net|fresha\.com|booksy\.com|vagaro\.com|mindbodyonline\.com|glofox\.com|zenoti\.com|setmore\.com|simplybook\.me)(?:\\?/[^\s\"'<>)\\]*)*",re.I)
SR_WIDGET=re.compile(r"sevenrooms[\s\S]{0,400}?venue_?id[\"']?\s*[:=]\s*[\"']([\w.-]{3,60})[\"']",re.I)
OT_WIDGET=re.compile(r"opentable\.[a-z.]+/widget/reservation/loader\?[^\"'<>\s]*?\brid=(\d+)",re.I)

def reg_domain(host):
  h=(host or "").lower().strip(".")
  if h.startswith("www."):h=h[4:]
  p=h.split(".")
  if len(p)>=3 and len(p[-1])==2 and p[-2] in ("co","com","net","org","gov","ac","edu","sch","ltd","plc"):return ".".join(p[-3:])
  return ".".join(p[-2:])

def provider(u):
  """URL → (провайдер, ссылка ведёт на конкретное заведение?, нормальная ссылка) или None."""
  try:p=urlparse(u)
  except Exception:return None
  h=(p.hostname or "").lower();path=p.path or "/";q=parse_qs(p.query)
  segs=[s for s in path.split("/") if s]
  if h.endswith("sevenrooms.com"):
    ok=bool(re.search(r"/(?:reservations|explore/[^/]+/reservations)(?:/|$)",path) and (len(segs)>=2 or q.get("venue")))
    return ("SevenRooms",ok,u)
  if re.search(r"(^|\.)opentable\.[a-z.]+$",h):
    if "/widget/reservation/loader" in path and q.get("rid"):return ("OpenTable",True,"https://www.opentable.com/restref/client/?rid="+q["rid"][0])
    ok=bool(q.get("rid") or q.get("restref") or re.match(r"^/(?:r|restaurant/profile)/.",path) or (len(segs)==1 and "-" in segs[0] and segs[0] not in("about-us","gift-cards","start-now")))
    return ("OpenTable",ok,u)
  if h.endswith("eatapp.co") or re.search(r"(^|\.)eat-app\.[a-z.]+$",h):
    ok=bool(segs) and segs[0].lower() not in ("blog","pricing","features","about","en","ar","careers","contact","integrations","restaurant-reservation-system","login","signup","resources","privacy","terms","product","solutions","customers","partners","demo","pos","static","assets","packs","widget.js")
    return ("Eat App",ok,u)
  if h.endswith("tablecheck.com"):
    ok="shops" in segs or "reserve" in segs
    return ("TableCheck",ok,u)
  if h.endswith("resy.com"):
    ok=("cities" in segs and len(segs)>=3) or h.startswith("widgets.") or bool(q.get("venueId"))
    return ("Resy",ok,u)
  if re.search(r"(^|\.)quandoo\.[a-z.]+$",h):return ("Quandoo","place" in segs or "widget" in h,u)
  if h.endswith("resdiary.com"):return ("ResDiary","restaurant" in segs or "widget" in segs or "widget" in path.lower(),u)
  if h.endswith("chope.co"):return ("Chope",bool(q.get("rid")) or "restaurant" in segs,u)
  if re.search(r"(^|\.)thefork\.[a-z.]+$",h):return ("TheFork","restaurant" in segs,u)
  if h.endswith("dineplan.com"):return ("Dineplan","restaurants" in segs and len(segs)>=2,u)
  if h.endswith("feverup.com"):return ("Fever",len(segs)>=2,u)
  if h.endswith("platinumlist.net"):return ("Platinumlist",any(s.endswith("-tickets") for s in segs) or bool(re.search(r"/\d+/",path)),u)
  for dom,name in (("fresha.com","Fresha"),("booksy.com","Booksy"),("vagaro.com","Vagaro"),("mindbodyonline.com","Mindbody"),("glofox.com","Glofox"),("zenoti.com","Zenoti"),("setmore.com","Setmore"),("simplybook.me","SimplyBook")):
    if h.endswith(dom):return (name,len(segs)>=1 and segs[0] not in("blog","pricing","features","about","for-business"),u)
  return None

def links(html,base):
  """Все <a>: (абсолютная ссылка, текст)."""
  out=[]
  for m in A_TAG.finditer(html):
    attrs=m.group(1);href=ATTR(attrs,"href")
    if not href or href.startswith(("#","javascript:","mailto:","tel:","sms:","whatsapp:","data:")):continue
    txt=re.sub(r"\s+"," ",HTML.unescape(TAGS.sub(" ",m.group(2)))).strip()
    if not txt:txt=ATTR(attrs,"aria-label") or ATTR(attrs,"title") or ""
    try:u=urljoin(base,href)
    except Exception:continue
    if not u.startswith("http"):continue
    out.append((u.split("#")[0],txt[:100]))
    if len(out)>=1500:break
  return out

def scan_page(html,page,site_dom):
  ents,actions=jsonld(html,page)
  md=microdata(html,page) if not ents else None
  if md:ents.append(md)
  booking=[];menu=[];follow=[]
  def add_b(u,prov,spec,txt,how):
    booking.append({"url":u[:500],"provider":prov,"specific":spec,"text":txt[:80],"how":how,"src":page})
  for kind,u in actions:
    if kind!="reserve":continue
    pv=provider(u)
    if pv:add_b(pv[2],pv[0],pv[1],"","jsonld-action")
    elif reg_domain(urlparse(u).hostname)==site_dom:add_b(u,"Website",True,"","jsonld-action")
  for e in ents:
    ar=e.get("acceptsReservations")
    if ar and ar.startswith("http"):
      pv=provider(ar)
      if pv:add_b(pv[2],pv[0],pv[1],"","jsonld-accepts")
      elif reg_domain(urlparse(ar).hostname)==site_dom:add_b(ar,"Website",True,"","jsonld-accepts")
    for u in e.get("menu",[]):menu.append({"url":u[:500],"text":"","kind":"pdf" if re.search(r"\.pdf(\?|$)",u,re.I) else "page","how":"jsonld","src":page})
  for u,txt in links(html,base=page):
    pu=urlparse(u);dom=reg_domain(pu.hostname)
    pv=provider(u)
    if pv:add_b(pv[2],pv[0],pv[1],txt,"a");continue
    same=dom==site_dom
    path=pu.path or "/"
    if same and (BOOK_TXT.match(txt) or BOOK_PATH.search(path)) and not re.search(r"\.(pdf|jpe?g|png)$",path,re.I):
      add_b(u,"Website",True,txt,"a")
      follow.append((0,u))
    is_pdf=bool(re.search(r"\.pdf(\?|$)",u,re.I))
    last=path.rstrip("/").rsplit("/",1)[-1]
    by_txt=bool(MENU_TXT.search(txt) and not MENU_BAD_TXT.search(txt) and len(txt)<=40)
    by_path=bool(MENU_PATH.search("/"+last) and (same or is_pdf) and (len(last)<=30 or is_pdf))
    if by_txt and same and (path in ("","/") or u.rstrip("/")==page.split("#")[0].rstrip("/")):by_txt=False  # «Menu» — кнопка навигации
    if (by_txt or by_path) and not SKIP_HOST.search(pu.hostname or "") and not re.search(r"/wp-(?:json|admin)|menu-item|mega-?menu",u,re.I):
      menu.append({"url":u[:500],"text":txt[:80],"kind":"pdf" if is_pdf else "page","same":same,"how":"a","src":page})
      if same and not is_pdf:follow.append((2,u))
    elif same and CONTACT.search(path+" "+txt) and len(txt)<=40 and not is_pdf:
      follow.append((1,u))
  # Виджеты без ссылки <a>: iframe, скрипт, data-атрибуты.
  for m in RAW_URL.finditer(html):
    u=m.group(0).replace("\\/","/")
    pv=provider(u)
    if pv:add_b(pv[2],pv[0],pv[1],"","raw")
  for m in SR_WIDGET.finditer(html):
    add_b("https://www.sevenrooms.com/reservations/"+m.group(1).lower(),"SevenRooms",True,"","widget")
  for m in OT_WIDGET.finditer(html):
    add_b("https://www.opentable.com/restref/client/?rid="+m.group(1),"OpenTable",True,"","widget")
  return ents,booking,menu,follow

# ---------- сеть ----------
HOST_SEM=defaultdict(lambda:threading.BoundedSemaphore(PER_HOST));HS_LOCK=threading.Lock()
def host_sem(host):
  with HS_LOCK:return HOST_SEM[(host or "").lower()]
ROBOTS={};R_LOCK=threading.Lock();STATS=defaultdict(int);ST_LOCK=threading.Lock()
def stat(k,n=1):
  with ST_LOCK:STATS[k]+=n
def decode(buf,ctype):
  m=re.search(r"charset=([\w.:-]+)",ctype or "",re.I)
  enc=m.group(1) if m else None
  if not enc:
    m=re.search(rb"<meta[^>]+charset=[\"']?([\w.:-]+)",buf[:5000],re.I)
    enc=m.group(1).decode("ascii","ignore") if m else "utf-8"
  try:return buf.decode(enc,errors="replace")
  except LookupError:return buf.decode("utf-8",errors="replace")
def get(sess,url,accept_html=True,maxb=MAX_BYTES):
  host=urlparse(url).hostname
  sem=host_sem(host);sem.acquire()
  try:
    stat("requests")
    t0=time.time()
    r=sess.get(url,headers=H,timeout=TIMEOUT,stream=True,allow_redirects=True)
    try:
      ctype=(r.headers.get("content-type") or "").lower()
      buf=b""
      if r.status_code<400 and (not accept_html or "html" in ctype or "xml" in ctype or not ctype or "text/plain" in ctype):
        for chunk in r.iter_content(32768):
          buf+=chunk
          if len(buf)>=maxb or time.time()-t0>DEADLINE:break
      return r.status_code,r.url,ctype,buf[:maxb]
    finally:r.close()
  finally:sem.release()
def robots_for(sess,url):
  p=urlparse(url);key=f"{p.scheme}://{p.netloc}".lower()
  with R_LOCK:
    if key in ROBOTS:return ROBOTS[key]
  try:
    st,fin,ct,buf=get(sess,key+"/robots.txt",accept_html=False,maxb=500_000)
    if st>=500:rp=False
    elif st>=400:rp=True
    else:
      txt=decode(buf,ct)
      if re.search(r"<html|<!doctype",txt[:500],re.I):rp=True
      else:
        rp=robotparser.RobotFileParser();rp.parse(txt.splitlines())
  except Exception as e:
    rp=e
  with R_LOCK:ROBOTS[key]=rp
  return rp
def allowed(sess,url):
  rp=robots_for(sess,url)
  if rp is True:return True,None
  if rp is False:return False,"robots_5xx"
  if isinstance(rp,Exception):return False,"fetch:"+type(rp).__name__
  try:return (rp.can_fetch(BOT,url),None)
  except Exception:return True,None

def harvest(sess,site,n_places,dom_sites):
  rec={"site":site,"ok":False,"n_places":n_places}
  host=urlparse(site).hostname or ""
  if SKIP_HOST.search(host):rec["err"]="skip_host";return rec
  ok,why=allowed(sess,site)
  if not ok:
    rec["err"]=why or "robots_disallow";return rec
  try:st,fin,ct,buf=get(sess,site)
  except Exception as e:
    rec["err"]="fetch:"+type(e).__name__;return rec
  site_dom=reg_domain(host)
  # Страница заведения не открылась, а домен — его собственный (на нём нет
  # других мест): пробуем главную.
  if (st>=400 or not buf) and urlparse(site).path not in ("","/") and dom_sites.get(site_dom,0)<=1:
    root=f"{urlparse(site).scheme}://{host}/"
    ok,_=allowed(sess,root)
    if ok:
      try:
        st2,fin2,ct2,buf2=get(sess,root)
        if st2<400 and buf2:st,fin,ct,buf=st2,fin2,ct2,buf2;rec["via"]=root
      except Exception:pass
  rec["final_url"]=fin;rec["status"]=st
  if st>=400:rec["err"]=f"http_{st}";return rec
  if "html" not in ct and "xml" not in ct and ct:rec["err"]="not_html:"+ct[:40];return rec
  fh=urlparse(fin).hostname or ""
  if fh.lower()!=host.lower():
    ok,why=allowed(sess,fin)
    if not ok:rec["err"]="robots_disallow_final";return rec
  html=decode(buf,ct)
  if PARKED.search(html[:60000]) or PARKED.search(fin):rec["err"]="parked";return rec
  fdom=reg_domain(fh)
  ents,booking,menu,follow=scan_page(html,fin,fdom)
  pages=[fin]
  have_book=any(b["specific"] and b["provider"]!="Website" for b in booking)
  have_hours=any(e.get("openingHours") or e.get("openingHoursSpecification") for e in ents)
  have_menu=bool(menu)
  want=[]
  seen={fin.rstrip("/"),site.rstrip("/")}
  for pr,u in sorted(follow,key=lambda x:x[0]):
    k=u.rstrip("/")
    if k in seen:continue
    if pr==0 and have_book:continue          # страница брони — ищем там виджет
    if pr==1 and have_hours:continue         # контакты — часы в JSON-LD
    if pr==2 and (have_book or have_hours):continue  # меню — иногда там бронь и часы
    seen.add(k);want.append(u)
    if len(want)>=MAX_SUB:break
  for u in want:
    if STOP.is_set():break
    ok,_=allowed(sess,u)
    if not ok:stat("robots_sub_disallow");continue
    try:
      st2,fin2,ct2,buf2=get(sess,u)
      if st2>=400 or not buf2 or ("html" not in ct2 and ct2):continue
      if reg_domain(urlparse(fin2).hostname)!=fdom:continue
      e2,b2,m2,_=scan_page(decode(buf2,ct2),fin2,fdom)
      pages.append(fin2);ents+=e2;booking+=b2;menu+=[m for m in m2 if m["url"].rstrip("/")!=fin2.rstrip("/") or m["kind"]=="pdf"]
    except Exception:continue
  # дубликаты
  def dedup(xs,key):
    seen=set();out=[]
    for x in xs:
      k=key(x)
      if k in seen:continue
      seen.add(k);out.append(x)
    return out
  rec["ok"]=True;rec["pages"]=pages
  rec["entities"]=dedup(ents,lambda e:json.dumps({k:v for k,v in e.items() if k!="src"},sort_keys=True))[:200]
  rec["booking"]=dedup(booking,lambda b:b["url"].rstrip("/").lower())[:20]
  rec["menu"]=dedup(menu,lambda m:m["url"].rstrip("/").lower())[:10]
  return rec

# После повтора: одна строка на сайт — удачная, иначе последняя.
def compact(path):
  best={}
  for line in open(path,encoding="utf-8"):
    try:r=json.loads(line)
    except Exception:continue
    prev=best.get(r["site"])
    if prev is None or r.get("ok") or not prev.get("ok"):best[r["site"]]=r
  tmp=path+".tmp"
  with open(tmp,"w",encoding="utf-8") as f:
    for r in best.values():f.write(json.dumps(r,ensure_ascii=False,separators=(",",":"))+"\n")
  os.replace(tmp,path)
  print("сжато:",len(best),"сайтов",flush=True)
STOP=threading.Event()
def main():
  ap=argparse.ArgumentParser()
  ap.add_argument("--db",required=True);ap.add_argument("--out",required=True);ap.add_argument("--check")
  ap.add_argument("--workers",type=int,default=48);ap.add_argument("--limit",type=int,default=0);ap.add_argument("--sites",nargs="*")
  ap.add_argument("--retry",nargs="*",help="повторить сайты, чья запись — отказ с такой причиной (префикс), напр. fetch:ReadTimeout fetch:ProxyError")
  a=ap.parse_args()
  done=set()
  if os.path.exists(a.out):
    for line in open(a.out,encoding="utf-8"):
      try:
        r=json.loads(line)
        if a.retry and not r.get("ok") and str(r.get("err","")).startswith(tuple(a.retry)):done.discard(r["site"])
        else:done.add(r["site"])
      except Exception:pass
  check=json.load(open(a.check)) if a.check and os.path.exists(a.check) else {}
  db=sqlite3.connect(f"file:{a.db}?mode=ro",uri=True)
  users=defaultdict(int)
  for (tj,) in db.execute("select tags_json from place"):
    t=json.loads(tj);s=str(t.get("website") or t.get("contact:website") or t.get("url") or "").strip()
    if not s:continue
    if "://" not in s:s="http://"+s
    users[s]+=1
  sites=[s for s in users if s not in done]
  if a.sites:sites=[s for s in a.sites if s not in done]
  if a.limit:sites=sites[:a.limit]
  dom_sites=defaultdict(int)
  for s in users:dom_sites[reg_domain(urlparse(s).hostname)]+=1
  out=open(a.out,"a",encoding="utf-8");lock=threading.Lock()
  def write(r):
    r["fetched_at"]=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())
    with lock:
      out.write(json.dumps(r,ensure_ascii=False,separators=(",",":"))+"\n");out.flush()
  skipped=0;todo=[]
  for s in sites:
    v=(check.get(s) or {}).get("v")
    if v in ("spam","parked"):write({"site":s,"ok":False,"n_places":users[s],"err":"skip:"+v});skipped+=1
    else:todo.append(s)
  # Сайты одного хоста — в одну-две очереди: не больше 2 запросов к хосту разом.
  by_host=defaultdict(list)
  for s in todo:by_host[(urlparse(s).hostname or "").lower()].append(s)
  chunks=[]
  for h,ss in by_host.items():
    k=min(PER_HOST,len(ss))
    for i in range(k):chunks.append(ss[i::k])
  chunks.sort(key=len,reverse=True)
  print(f"сайтов всего {len(users)}, уже есть {len(done)}, спам/парковка {skipped}, к обходу {len(todo)} ({len(by_host)} хостов, {len(chunks)} очередей)",flush=True)
  n=[0];t0=time.time()
  agg=defaultdict(int)
  def run(chunk):
    sess=requests.Session();sess.max_redirects=6
    ad=requests.adapters.HTTPAdapter(pool_connections=4,pool_maxsize=PER_HOST,max_retries=0)
    sess.mount("http://",ad);sess.mount("https://",ad)
    try:
      for s in chunk:
        if STOP.is_set():return
        try:r=harvest(sess,s,users[s],dom_sites)
        except Exception as e:r={"site":s,"ok":False,"n_places":users[s],"err":"crash:"+type(e).__name__}
        write(r)
        with lock:
          n[0]+=1;agg["ok"]+=r["ok"]
          if r.get("entities"):agg["ent"]+=1
          if any(e.get("openingHours") or e.get("openingHoursSpecification") for e in r.get("entities",[])):agg["hours"]+=1
          if any(e.get("priceRange") for e in r.get("entities",[])):agg["price"]+=1
          if any(b["specific"] and b["provider"]!="Website" for b in r.get("booking",[])):agg["book3p"]+=1
          if any(b["provider"]=="Website" for b in r.get("booking",[])):agg["bookweb"]+=1
          if r.get("menu"):agg["menu"]+=1
          if n[0]%250==0:
            el=time.time()-t0
            print(f"{n[0]}/{len(todo)} {round(el)}с ok {agg['ok']} ld {agg['ent']} часы {agg['hours']} цена {agg['price']} бронь {agg['book3p']}+{agg['bookweb']}сайт меню {agg['menu']} запросов {STATS['requests']}",flush=True)
    finally:sess.close()
  def on_term(sig,frm):
    print("SIGTERM: заканчиваю начатые сайты",flush=True);STOP.set()
  signal.signal(signal.SIGTERM,on_term);signal.signal(signal.SIGINT,on_term)
  with ThreadPoolExecutor(a.workers) as ex:
    pending={ex.submit(run,c) for c in chunks}
    while pending:
      _,pending=wait(pending,timeout=5,return_when=FIRST_COMPLETED)
      if STOP.is_set():
        for f in pending:f.cancel()
  out.close()
  if a.retry:compact(a.out)
  print(("ОСТАНОВЛЕНО" if STOP.is_set() else "ГОТОВО"),n[0],dict(agg),"запросов",STATS["requests"],round(time.time()-t0),"с",flush=True)
if __name__=="__main__":main()
