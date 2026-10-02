# Второй заход по сайтам без фото: дольше ждём, браузерный заголовок,
# при 403/404 — главная страница сайта, кадры от 400 px.
import json,sys,re,threading,time
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.parse import urlparse
import harvest_lib as H
SRC=sys.argv[1];OUT=sys.argv[2]
last={}
for l in open(SRC):
  r=json.loads(l);last[r["site"]]=r
todo=[s for s,r in last.items() if "img" not in r and r.get("err","").split(":")[0].split("_")[0] in("fetch","http","small","no","img","aspect")]
print("повтор:",len(todo),flush=True)
out=open(OUT,"a");lock=threading.Lock();n=ok=0;t0=time.time()
with ThreadPoolExecutor(64) as ex:
  futs={ex.submit(H.work,s):s for s in todo}
  for f in as_completed(futs):
    try:r=f.result()
    except Exception:continue
    with lock:
      out.write(json.dumps(r,ensure_ascii=False)+"\n");n+=1
      if "img" in r:ok+=1
      if n%500==0:out.flush();print(f"{n}/{len(todo)} фото {ok} {round(time.time()-t0)}с",flush=True)
out.close();print("ГОТОВО",n,ok,flush=True)
