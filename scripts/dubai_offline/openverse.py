# Иллюстративные фото по темам из Openverse (CC-лицензии, с автором).
import json,sys,time,urllib.parse,os,requests
S=os.path.dirname(os.path.abspath(__file__))
topics=json.load(open(f"{S}/topics.json"))
out_path=f"{S}/openverse_raw2.json"
raw=json.load(open(out_path)) if os.path.exists(out_path) else {}
H={"User-Agent":"FREE-Dubai/1.0 (+https://afishasity.ru; city concierge)"}
for key,q in topics.items():
  if key in raw and raw[key].get("results"):continue
  url="https://api.openverse.org/v1/images/?"+urllib.parse.urlencode({"q":q,"page_size":20,"license_type":"commercial","aspect_ratio":"wide","mature":"false","source":"flickr,stocksnap,rawpixel"})
  for attempt in range(3):
    r=requests.get(url,headers=H,timeout=30)
    if r.status_code==429:
      print("429, жду",r.headers.get("retry-after"),flush=True);time.sleep(int(r.headers.get("retry-after") or 60));continue
    break
  try:d=r.json()
  except Exception:d={}
  raw[key]={"q":q,"status":r.status_code,"left":r.headers.get("x-ratelimit-available-anon_sustained"),"results":d.get("results",[])}
  json.dump(raw,open(out_path,"w"))
  print(key,r.status_code,len(raw[key]["results"]),"осталось/сутки",raw[key]["left"],flush=True)
  time.sleep(3.4)
print("ГОТОВО",flush=True)
