import json,urllib.request,time,re,sys,sqlite3,math,concurrent.futures as cf
S=sys.argv[1];mode=sys.argv[2];DB=next((a for a in sys.argv[3:] if a.endswith(".db")),f"{S}/osm_dubai.new.db")
db=sqlite3.connect(DB)
def dbtags(rid):
  m=re.match(r"osm:(\w+):(\d+)",rid or "")
  if not m:return {}
  r=db.execute("select tags_json from place where pid=?",(f"{m.group(1)}/{m.group(2)}",)).fetchone()
  return json.loads(r[0]) if r else {}
ALIAS={"supermarket":{"grocery"},"grocery":{"supermarket"},"spa":{"massage","pool"},"massage":{"spa"},"beauty":{"nails","barber","cosmetology"},
 "cosmetology":{"beauty","clinic"},"clinic":{"hospital","dentist","cosmetology"},"hospital":{"clinic"},"family":{"themepark","park","zoo","aquapark"},
 "food":{"coffee","bakery","pastry","hookah","bar"},"coffee":{"food","bakery","pastry"},"bar":{"club","hookah","food"},"club":{"bar"},"hookah":{"bar","food","coffee"},
 "pastry":{"bakery","coffee"},"bakery":{"pastry","coffee"},"themepark":{"family","aquapark"},"concert":{"theatre"},"theatre":{"concert"},"tours":{"boat"},"boat":{"tours"},
 "mall":{"supermarket"},"gym":{"yoga","pool","climbing"},"yoga":{"gym"},"pool":{"gym","spa"},"market":{"grocery","supermarket"},"sights":{"museum","park","beach","mosque","mall","gallery"},
 "museum":{"gallery"},"gallery":{"museum"},"park":{"beach"},"beach":{"park","hotel"},"jewelry":{"market"},"carrepair":{"carwash"},"carwash":{"carrepair"},"electronics":{"phonerepair"},"phonerepair":{"electronics"}}
D={"Al Karama":(25.2463,55.3047),"Dubai Airport":(25.2532,55.3657),"Al Quoz":(25.1426,55.2259),"Bur Dubai":(25.2532,55.2970),"Dubai Marina":(25.0805,55.1403),"JBR":(25.0784,55.1338),"Downtown Dubai":(25.1972,55.2744),"JLT":(25.0693,55.1428),"Deira":(25.2711,55.3075),"Jumeirah":(25.2093,55.2462),"Business Bay":(25.1857,55.2725),"Palm Jumeirah":(25.1124,55.1390),"Al Barsha":(25.1124,55.1960)}
def hav(a,b):
  R=6371;x=math.radians(b[0]-a[0]);y=math.radians(b[1]-a[1])
  return 2*R*math.asin(math.sqrt(math.sin(x/2)**2+math.cos(math.radians(a[0]))*math.cos(math.radians(b[0]))*math.sin(y/2)**2))
if mode=="cats":qs=json.load(open(f"{S}/queries.json"))
else:qs=json.load(open(f"{S}/{mode}.json"))
def run(x):
  q=x["q"];t=time.time()
  body=json.dumps({"query":q,"user_location":{"lat":25.1972,"lon":55.2744}}).encode()
  try:
    d=json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3001/api/recommend",data=body,headers={"Content-Type":"application/json","X-Free-Client":"qa-audit-0003"}),timeout=120))
  except Exception as e:return (x,None,str(e)[:80],0)
  return (x,d,None,round(time.time()-t,1))
with cf.ThreadPoolExecutor(4) as ex:res=list(ex.map(run,qs))
tot={"cards":0,"addr":0,"contact":0,"hours":0,"latin":0,"coords":0,"cat":0,"photo":0,"real":0,"illus":0,"dup":0};problems=[];empty=[];errors=[];shots=[]
for x,d,err,sec in res:
  if err:errors.append((x["q"],err));continue
  rs=d.get("results") or []
  if not rs:empty.append(x["q"]);continue
  ill=[(r.get("photo") or {}).get("url") for r in rs if (r.get("photo") or {}).get("origin")=="illustrative"]
  tot["dup"]+=len(ill)-len(set(ill))
  exp=set(x.get("tags") or ([x["tag"]] if x.get("tag") else []));ok=set(exp)
  for t in exp:ok|=ALIAS.get(t,set())
  for i,r in enumerate(rs):
    tot["cards"]+=1
    ct=set(r.get("cat_tags") or []);tg=dbtags(r.get("id"))
    if r.get("area") and r["area"]!="Dubai":tot["addr"]+=1
    if re.search("[а-яё\u0600-\u06FF]",str(r.get("area") or "")+str(r.get("category") or ""),re.I):problems.append((x["q"],"НЕЛАТИНСКИЙ АДРЕС/КАТЕГОРИЯ",f"{r.get('name')} | {r.get('area')}"))
    if r.get("phone") or (r.get("booking_url") or "").startswith(("tel:","http")) or r.get("official_source"):tot["contact"]+=1
    if r.get("hours_label"):tot["hours"]+=1
    og=(r.get("photo") or {}).get("origin")
    if og not in (None,"generated"):tot["photo"]+=1
    if og in("venue_site","commons","aggregator","brand_logo"):tot["real"]+=1
    if og=="illustrative":tot["illus"]+=1
    shots.append({"q":x["q"],"name":r.get("name"),"origin":og,"url":(r.get("photo") or {}).get("url")})
    if og in(None,"generated"):problems.append((x["q"],"БЕЗ ФОТО",r.get("name")))
    if r.get("coords") and r["coords"].get("lat"):tot["coords"]+=1
    if r.get("category"):tot["cat"]+=1
    name=r.get("name") or ""
    if re.search("[A-Za-z]",name) and not re.search("[а-яё؀-ۿ一-鿿]",name,re.I):tot["latin"]+=1
    else:problems.append((x["q"],"НЕ ЛАТИНИЦА",name))
    if exp:
      if not (ct&ok):problems.append((x["q"],"КАТЕГОРИЯ",f"{name} [{r.get('category')}] {sorted(ct)}"))
    if x.get("district"):
      c=D[x["district"]];km=hav(c,(r["coords"]["lat"],r["coords"]["lon"]))
      if km>4:problems.append((x["q"],f"ДАЛЕКО {km:.1f}км",name))
    if x.get("cuisine") and i<3:
      hay=(name+" "+(tg.get("cuisine") or "")+" "+(r.get("category") or "")).lower()
      if not re.search(x["cuisine"],hay):problems.append((x["q"],"КУХНЯ",f"{name} cuisine={tg.get('cuisine')}"))
    if x.get("expect") and i==0 and not re.search(x["expect"],name,re.I):problems.append((x["q"],"ПЕРВЫМ ОЖИДАЛОСЬ "+x["expect"],name))
  if mode!="cats" or "-v" in sys.argv:print(f"{x['q'][:34]:35}{len(rs):>2} {sec:>5}s  "+" | ".join(f"{r.get('name','')[:26]} ({r.get('category')})" for r in rs[:5]))
N=tot["cards"] or 1
print(f"\nИТОГО запросов {len(qs)}, карточек {tot['cards']}: адрес {round(100*tot['addr']/N)}%, контакт {round(100*tot['contact']/N)}%, часы {round(100*tot['hours']/N)}%, фото {round(100*tot['photo']/N)}% (своё {round(100*tot['real']/N)}%, пример {round(100*tot['illus']/N)}%, повторов примера в выдаче {tot['dup']}), координаты {round(100*tot['coords']/N)}%, подпись категории {round(100*tot['cat']/N)}%, латиница {round(100*tot['latin']/N)}%")
json.dump(shots,open(f"{S}/shots_{mode}.json","w"))
print("ПУСТЫХ:",len(empty),empty);print("ОШИБОК:",len(errors),errors);print("ПРОБЛЕМ:",len(problems))
for p in problems:print("  ",p)
