"""Список гида MICHELIN Dubai → curated/michelin.json.

  python3 scripts/dubai_offline/michelin.py $W [URL статьи «full list»] ["MICHELIN Guide Dubai 2026"]

Берёт статью с полным списком (звёзды, Bib Gourmand, Selected) и страницу
каждого ресторана на guide.michelin.com: координаты, адрес, телефон и кухня —
из JSON-LD страницы, сайт — из кнопки «Website». Точка, которая противоречит
адресу (Milos: адрес Atlantis The Royal, точка в Аль-Кузе), заменяется
координатами ориентира из fixes.json; без ориентира — убирается. Ресторан,
чьей страницы уже нет (404), остаётся в списке без координат: его метят по
точному имени, но в карту не добавляют.
$W нужна ради cats.json (районы для сверки адреса).
"""
import re,html,json,time,subprocess,sys,os
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import curate
W=sys.argv[1]
URL=sys.argv[2] if len(sys.argv)>2 else "https://guide.michelin.com/ae-du/en/article/michelin-guide-ceremony/full-list-michelin-guide-dubai-selection"
TITLE=sys.argv[3] if len(sys.argv)>3 else "MICHELIN Guide Dubai 2025 (4th edition, announced 22 May 2025; the 2026 edition is announced on 6 October 2026)"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
def get(u):
  r=subprocess.run(["curl","-sS","-L","-A",UA,"-w","\n%{http_code}",u],capture_output=True,text=True,timeout=60)
  body,code=r.stdout.rsplit("\n",1);return int(code),body
code,s=get(URL)
if code!=200:sys.exit(f"статья недоступна: HTTP {code}")
t=re.sub(r"<script.*?</script>|<style.*?</style>","",s,flags=re.S)
txt=html.unescape(re.sub(r"<[^>]+>","",re.sub(r"<(h[1-6]|p|li|br|div)[^>]*>","\n",t)))
lines=[l.strip() for l in txt.split("\n") if l.strip()]
HDR=[("Three MICHELIN Star Restaurants","3 Stars"),("Two MICHELIN Star Restaurants","2 Stars"),("One MICHELIN Star Restaurants","1 Star"),
     ("MICHELIN Green Star Restaurants","green"),("Bib Gourmand Restaurants","Bib Gourmand"),("MICHELIN Selected Restaurants","Selected")]
start=next(i for i,l in enumerate(lines) if re.match(r"^\d+ Three MICHELIN",l))
sect=None;dist={}
for l in lines[start:]:
  if l.startswith("Subscribe to our newsletter"):break
  h=next((v for k,v in HDR if re.match(r"^\d+ "+k,l)),None)
  if h:sect=h;continue
  # Подписи к фотографиям («… Image credit: …») — не рестораны.
  if sect and "Image credit" not in l and len(l)<70:
    dist.setdefault(re.sub(r"\s*\((NEW|PROMOTED)\)$","",l),[]).append(sect)
url={}
for h,tx in re.findall(r'<a[^>]+href="([^"]*/restaurant/[^"]*)"[^>]*>(.*?)</a>',s,flags=re.S):
  nm=html.unescape(re.sub("<[^>]+>","",tx)).strip()
  # «Sucre» в статье ссылается на страницу StreetXO: чужая ссылка — не ссылка.
  if nm and nm not in url and h not in url.values():url[nm]=h
BASE=re.sub(r"/article/.*$","",URL)+"/dubai-emirate/dubai/restaurant/"
slug=lambda n:re.sub(r"[^a-z0-9]+","-",curate.fold(n)).strip("-")
cfg=json.load(open(f"{W}/cats.json"))
geo=curate.Geo(cfg,curate.load("fixes.json"))
out=[]
for nm,ds in dist.items():
  aw=[d for d in ds if d!="green"]
  rec={"name":nm,"distinction":aw[0] if aw else None}
  if "green" in ds:rec["green_star"]=True
  # Без ссылки в статье (FZN, Pierchic) — страница по имени.
  u=url.get(nm) or BASE+slug(nm);rec["url"]=u
  r={}
  if u:
    code,b=get(u)
    if code==200:
      for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>',b,flags=re.S):
        try:j=json.loads(m.group(1))
        except Exception:continue
        if isinstance(j,dict) and j.get("@type")=="Restaurant":
          r={"lat":j.get("latitude"),"lon":j.get("longitude"),"address":(j.get("address") or {}).get("streetAddress"),"phone":j.get("telephone"),"cuisine":j.get("servesCuisine")}
      w=re.search(r'data-event="CTA_website"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*data-event="CTA_website"',b)
      if w:r["website"]=w.group(1) or w.group(2)
    else:rec["page"]=f"HTTP {code} on guide.michelin.com: tagged by exact name only, never added"
    time.sleep(0.6)
  lat,lon=r.get("lat"),r.get("lon")
  ok=lat is not None and 24.6<lat<25.6 and 54.8<lon<56.3          # «Sucre» ссылкой ведёт на лондонский ресторан
  if ok and geo.verdict(nm,r.get("address"),lat,lon)[0]=="contra":
    lm=[l for l in geo.landmarks if l[0].search(curate.fold(r.get("address") or ""))]
    if lm:lat,lon=lm[0][1];rec["coords_note"]=f"guide.michelin.com point is off; coordinates of {lm[0][3]} from its address"
    else:ok=False
  rec["lat"]=lat if ok else None;rec["lon"]=lon if ok else None
  if not ok and u and "page" not in rec:rec["url"]=None
  if ok:
    for k in("address","phone","website","cuisine"):
      if r.get(k):rec[k]=r[k]
  out.append(rec);print(nm,rec["distinction"],rec["lat"],rec["lon"],file=sys.stderr)
doc={"_about":"MICHELIN Guide Dubai — the current edition. Coordinates, address, phone and website come from each restaurant's page on guide.michelin.com (JSON-LD). Records without coordinates are matched by exact name only. Regenerate with scripts/dubai_offline/michelin.py when a new edition is announced.",
     "edition":{"title":TITLE,"src":URL},"restaurants":out}
p=os.path.join(curate.CURATED,"michelin.json")
json.dump(doc,open(p,"w",encoding="utf-8"),ensure_ascii=False,indent=1)
print(len(out),"ресторанов →",p)
