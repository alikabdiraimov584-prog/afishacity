# Проверка собранных фото мест: скачиваем, отличаем фото от логотипа/плаката.
import json,os,io,hashlib,threading,requests,time
from concurrent.futures import ThreadPoolExecutor,as_completed
from PIL import Image,ImageFile
from flat import feats2 as metrics,is_photo2 as is_photo
ImageFile.LOAD_TRUNCATED_IMAGES=True
os.makedirs("vthumbs2",exist_ok=True)
imgs={}
for l in open("site_photos.jsonl"):
  r=json.loads(l)
  if "img" in r:imgs[r["img"]]=r.get("site")
qa=json.load(open("site_photos_qa2.json")) if os.path.exists("site_photos_qa2.json") else {}
todo=[u for u in imgs if u not in qa]
print("к проверке",len(todo),flush=True)
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
def chk(u):
  try:
    r=requests.get(u,headers={"User-Agent":UA,"Accept":"image/avif,image/webp,image/*;q=0.8","Referer":imgs[u]},timeout=20)
    if r.status_code!=200:return u,{"ok":False,"why":f"http_{r.status_code}"}
    m=metrics(r.content)
    k=hashlib.md5(u.encode()).hexdigest()[:12]
    try:
      im=Image.open(io.BytesIO(r.content)).convert("RGB");im.thumbnail((200,130));im.save(f"vthumbs2/{k}.jpg",quality=70)
    except Exception:pass
    if "hugedomains" in u or "godaddy" in u or "domain" in u.lower() and "sale" in u.lower():return u,{"ok":False,"why":"parked","m":m,"k":k}
    return u,{"ok":is_photo(m),"m":m,"k":k}
  except Exception as e:
    return u,{"ok":False,"why":"err"}
n=0;lock=threading.Lock()
with ThreadPoolExecutor(48) as ex:
  for f in as_completed([ex.submit(chk,u) for u in todo]):
    u,res=f.result();qa[u]=res;n+=1
    if n%1000==0:
      json.dump(qa,open("site_photos_qa2.json","w"));print(n,flush=True)
json.dump(qa,open("site_photos_qa2.json","w"))
ok=sum(1 for v in qa.values() if v.get("ok"));print("ГОТОВО",len(qa),"фото",ok,flush=True)
