# Отбор фото для примера: доступна, крупная, горизонтальная; до 6 на тему.
import json,io,os,sys,requests,hashlib
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
S=os.path.dirname(os.path.abspath(__file__))
raw=json.load(open(f"{S}/openverse_raw2.json"))
os.makedirs(f"{S}/thumbs",exist_ok=True)
UA={"User-Agent":"Mozilla/5.0 (FREE-Dubai photo check)"}
LIC={"by":"CC BY","by-sa":"CC BY-SA","cc0":"CC0","pdm":"Public domain","by-nd":"CC BY-ND"}
BAD_TITLE=__import__("re").compile(r"\b(logo|map|diagram|screenshot|poster|flyer|menu|sign|text|chart|drawing|illustration|cartoon|meme)\b",__import__("re").I)
def check(r):
  url=r.get("url")
  if not url:return None
  if BAD_TITLE.search(r.get("title") or ""):return None
  try:
    resp=requests.get(url,headers=UA,timeout=20)
    if resp.status_code!=200 or not resp.headers.get("content-type","").startswith("image/"):return None
    im=Image.open(io.BytesIO(resp.content));w,h=im.size
    from flat import metrics,is_photo
    if not is_photo(metrics(resp.content)):return None
    if w<640 or h<360:return None
    a=w/h
    if a<1.2 or a>2.3:return None
    k=hashlib.md5(url.encode()).hexdigest()[:12]
    im.convert("RGB").resize((240,int(240*h/w))).save(f"{S}/thumbs/{k}.jpg",quality=70)
    return {"url":url,"w":w,"h":h,"creator":r.get("creator"),"landing":r.get("foreign_landing_url"),
      "license":(LIC.get(r.get("license"),r.get("license","").upper())+(" "+r["license_version"] if r.get("license_version") and r.get("license") not in("cc0","pdm") else "")).strip(),
      "license_url":r.get("license_url"),"title":r.get("title"),"thumb":k}
  except Exception:
    return None
pool={}
with ThreadPoolExecutor(16) as ex:
  for key,v in raw.items():
    res=[x for x in ex.map(check,v.get("results",[])[:20]) if x]
    pool[key]=res[:10]
    print(key,len(v.get("results",[])),"->",len(pool[key]),flush=True)
json.dump(pool,open(f"{S}/pool_candidates.json","w"),ensure_ascii=False,indent=0)
