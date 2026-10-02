import json,re,sys,osmium
S=sys.argv[1]
cfg=json.load(open(f"{S}/cats.json"));B=cfg["bbox"]
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
    lat=sum(p[0] for p in pts)/len(pts);lon=sum(p[1] for p in pts)/len(pts)
    self.emit("way",w.id,lat,lon,tags)
  # Мультиполигоны-отношения: The Dubai Mall, Souk Al Bahar, Meydan — раньше
  # терялись целиком, потому что обрабатывались только точки и линии.
  def area(self,a):
    if a.from_way():return
    if not a.tags:return
    tags={x.k:x.v for x in a.tags}
    if not (tags.get("name") or tags.get("name:en")):return
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
print("улиц в словаре:",len(STREETS))
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
