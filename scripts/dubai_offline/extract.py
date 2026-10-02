import json,re,sys,osmium,datetime
from collections import Counter
S=sys.argv[1]
cfg=json.load(open(f"{S}/cats.json"));B=cfg["bbox"]
TODAY=datetime.date.today().isoformat()
# Закрытые и ещё не открытые места: человеку их не предлагаем.
# «closed=yes», «disused=yes», «disused:shop=…»/«was:amenity=…» рядом с живым
# shop/amenity (заведение съехало, тег не убрали), «opening_date» в будущем.
CLOSED=Counter()
LIFECYCLE=re.compile(r"^(disused|was|abandoned|demolished|razed|removed|destroyed):(shop|amenity|tourism|leisure|office|craft|healthcare|club|sport)$")
CLOSED_NAME=re.compile(r"\((?:permanently )?closed\)|\bpermanently closed\b|\bclosed down\b|\bcoming soon\b|\bopening soon\b|\bwill open\b|\bunder construction\b|تمت ?[اإ]زالته|مغلق نهائيا",re.I)
def closed_reason(tags):
  if str(tags.get("closed","")).lower() in("yes","permanently"):return "closed=yes"
  if str(tags.get("disused","")).lower()=="yes" or str(tags.get("abandoned","")).lower()=="yes":return "disused=yes"
  if any(LIFECYCLE.match(k) for k in tags):return "disused:*/was:*"
  od=str(tags.get("opening_date",""))[:10]
  if re.match(r"^\d{4}(-\d\d){0,2}$",od) and od>TODAY[:len(od)]:return "opening_date in future"
  ed=str(tags.get("end_date","") or tags.get("closed:date","") or "")[:10]
  if re.match(r"^\d{4}(-\d\d){0,2}$",ed) and ed<=TODAY[:len(ed)]:return "end_date passed"
  if any(CLOSED_NAME.search(tags.get(k) or "") for k in("name","name:en","name:ar")):return "closed in name"
  return None
# Границы эмиратов (admin_level=4): merge.py обрезает места по Дубаю.
BOUNDS={}
COAST=set()
CLAUSE=re.compile(r'\[\s*"([^"]+)"\s*(?:(=|!=|~|!~)\s*"([^"]*)"\s*(,i)?)?\s*\]')
def parse(f):
  body=f.split("({{bbox}})")[0]
  m=re.match(r'\s*(nwr|node|way|relation|nw|nr|wr)',body);types=m.group(1) if m else "nwr"
  conds=[]
  for k,op,v,ci in CLAUSE.findall(body):
    if not op: conds.append((k,"has",None));continue
    if op in("~","!~"): conds.append((k,op,re.compile(v,re.I if ci else 0)))
    else: conds.append((k,op,v))
  return types,conds
CATS=[(c["tag"],[parse(f) for f in c["osm"]]) for c in cfg["cats"]]
def match(tags,conds):
  for k,op,v in conds:
    x=tags.get(k)
    if op=="has":
      if x is None:return False
    elif op=="=":
      if x!=v:return False
    elif op=="!=":
      if x==v:return False
    elif op=="~":
      if x is None or not v.search(x):return False
    elif op=="!~":
      if x is not None and v.search(x):return False
  return True
def inb(lat,lon):return B["south"]<=lat<=B["north"] and B["west"]<=lon<=B["east"]
out={t:[] for t,_ in CATS}
STREETS={}
class H(osmium.SimpleHandler):
  def emit(self,typ,oid,lat,lon,tags):
    if not inb(lat,lon):return
    t=None
    for tag,fs in CATS:
      for types,conds in fs:
        if typ[0] not in types and types!="nwr":continue
        if match(tags,conds):
          if t is None:
            why=closed_reason(tags)
            if why:CLOSED[why]+=1;return
          if t is None:t={"type":typ,"id":oid,"lat":lat,"lon":lon,"tags":tags} if typ=="node" else {"type":typ,"id":oid,"center":{"lat":lat,"lon":lon},"tags":tags}
          out[tag].append(t);break
  def node(self,n):
    if not n.tags:return
    tags={x.k:x.v for x in n.tags}
    self.emit("node",n.id,n.location.lat,n.location.lon,tags)
  def way(self,w):
    if not w.tags:return
    tags={x.k:x.v for x in w.tags}
    # Словарь улиц: арабское имя → английское (для адресов «addr:street»).
    if tags.get("highway") and tags.get("name") and tags.get("name:en"):STREETS[tags["name"]]=tags["name:en"]
    try:
      pts=[(nd.location.lat,nd.location.lon) for nd in w.nodes if nd.location.valid()]
    except Exception:return
    if not pts:return
    # Береговая линия: пляж из Overture в 3 км от моря — не пляж (merge.py).
    if tags.get("natural")=="coastline":
      for la,lo in pts:
        if inb(la,lo):COAST.add((round(la,4),round(lo,4)))
      return
    lat=sum(p[0] for p in pts)/len(pts);lon=sum(p[1] for p in pts)/len(pts)
    self.emit("way",w.id,lat,lon,tags)
  # Мультиполигоны-отношения: The Dubai Mall, Souk Al Bahar, Meydan — раньше
  # терялись целиком, потому что обрабатывались только точки и линии.
  def area(self,a):
    if a.from_way():return
    if not a.tags:return
    tags={x.k:x.v for x in a.tags}
    if not (tags.get("name") or tags.get("name:en")):return
    if tags.get("boundary")=="administrative" and tags.get("admin_level")=="4":
      # Эмират целиком: внешние кольца с дырками (анклавы, Хатта отдельно).
      polys=[]
      try:
        for outer in a.outer_rings():
          ring=[(nd.location.lon,nd.location.lat) for nd in outer if nd.location.valid()]
          holes=[[(nd.location.lon,nd.location.lat) for nd in inner if nd.location.valid()] for inner in a.inner_rings(outer)]
          if len(ring)>=4:polys.append({"outer":ring,"holes":[h for h in holes if len(h)>=4]})
      except Exception:polys=[]
      if polys:BOUNDS[tags.get("name:en") or tags["name"]]={"osm_id":a.orig_id(),"polygons":polys}
      return
    pts=[]
    try:
      for ring in a.outer_rings():
        for nd in ring:
          if nd.location.valid():pts.append((nd.location.lat,nd.location.lon))
    except Exception:return
    if not pts:return
    lat=sum(p[0] for p in pts)/len(pts);lon=sum(p[1] for p in pts)/len(pts)
    self.emit("relation",a.orig_id(),lat,lon,tags)
H().apply_file(f"{S}/uae.osm.pbf",locations=True)
json.dump(out,open(f"{S}/dubai_by_cat.json","w"))
json.dump(STREETS,open(f"{S}/streets.json","w"),ensure_ascii=False)
json.dump(BOUNDS,open(f"{S}/boundaries.json","w"),ensure_ascii=False)
json.dump(sorted(COAST),open(f"{S}/coast.json","w"))
print("точек береговой линии:",len(COAST))
print("улиц в словаре:",len(STREETS))
print("границы эмиратов:",{k:sum(len(p["outer"]) for p in v["polygons"]) for k,v in BOUNDS.items()})
print("закрытые/ещё не открытые (выброшено):",dict(CLOSED))
# Аудит полей
def has(t,*ks):return any(t.get(k) for k in ks)
rows=[]
for tag,_ in CATS:
  els=out[tag];n=len(els)
  if n==0:rows.append((tag,0,0,0,0,0,0,0));continue
  named=[e for e in els if e["tags"].get("name") or e["tags"].get("name:en")]
  m=len(named) or 1
  pct=lambda f:round(100*sum(1 for e in named if f(e["tags"]))/m)
  rows.append((tag,n,len(named),pct(lambda t:has(t,"addr:street","addr:full","addr:place","addr:housenumber")),pct(lambda t:has(t,"opening_hours")),pct(lambda t:has(t,"phone","contact:phone")),pct(lambda t:has(t,"website","contact:website","url")),pct(lambda t:has(t,"image","wikimedia_commons","wikidata","brand:wikidata"))))
print(f"{'категория':14}{'всего':>7}{'с именем':>9}{'адрес%':>8}{'часы%':>7}{'тел%':>6}{'сайт%':>7}{'фото%':>7}")
for r in rows:print(f"{r[0]:14}{r[1]:>7}{r[2]:>9}{r[3]:>8}{r[4]:>7}{r[5]:>6}{r[6]:>7}{r[7]:>7}")
print("ИТОГО мест с именем:",sum(r[2] for r in rows))
