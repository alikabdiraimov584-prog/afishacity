# Сбор настоящих фото мест с их сайтов: og:image / twitter:image / JSON-LD image.
# Каждый кадр проверяется: это растровая картинка, ширина ≥ 500, не логотип,
# не баннер-полоска. Результат — JSONL: сайт → фото (или причина отказа).
import json,re,sys,io,os,sqlite3,threading,time
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.parse import urljoin,urlparse
import requests
from PIL import Image
DB=sys.argv[1];OUT=sys.argv[2];WORKERS=int(sys.argv[3]) if len(sys.argv)>3 else 48
UA="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
H={"User-Agent":UA,"Accept":"text/html,application/xhtml+xml","Accept-Language":"en-US,en;q=0.9"}
BAD=re.compile(r"logo|sprite|placeholder|favicon|\bicons?\b|/icons?/|noimage|no-image|no_image|avatar|blank|spacer|pixel|badge|apple-touch|qr-?code|default-(?:og|share|image)|og-default|share-default|loader|loading",re.I)
SKIP_HOST=re.compile(r"(^|\.)(google\.|goo\.gl|facebook\.com|fb\.com|wa\.me|whatsapp\.com|t\.me|tiktok\.com|youtube\.com|twitter\.com|x\.com|snapchat\.com|maps\.app\.goo\.gl|bit\.ly)",re.I)
done=set()
if os.path.exists(OUT):
  for line in open(OUT):
    try:
      r=json.loads(line);e=r.get("err","")
      if "img" in r or e.startswith(("fetch","http_","skip_host","not_html")):done.add(r["site"])
    except:pass
db=sqlite3.connect(DB)
sites=[]
seen=set()
for (tj,) in db.execute("select tags_json from place"):
  t=json.loads(tj)
  s=(t.get("website") or t.get("contact:website") or t.get("url") or "").strip()
  if not s:continue
  if "://" not in s:s="http://"+s
  if s in seen or s in done:continue
  seen.add(s);sites.append(s)
print("сайтов к обходу:",len(sites),"уже:",len(done),flush=True)
lock=threading.Lock();out=open(OUT,"a")
META=re.compile(r"<meta\b[^>]*>",re.I)
def attr(tag,name):
  m=re.search(name+r"\s*=\s*([\"'])(.*?)\1",tag,re.I|re.S);return m.group(2).strip() if m else None
def candidates(html,base):
  c=[]
  for tag in META.findall(html):
    p=(attr(tag,"property") or attr(tag,"name") or "").lower()
    if p in("og:image","og:image:secure_url","og:image:url","twitter:image","twitter:image:src"):
      v=attr(tag,"content")
      if v:c.append(v)
  for m in re.finditer(r"<script[^>]+application/ld\+json[^>]*>(.*?)</script>",html,re.I|re.S):
    try:
      d=json.loads(m.group(1).strip())
    except Exception:continue
    stack=[d]
    while stack:
      x=stack.pop()
      if isinstance(x,list):stack.extend(x);continue
      if not isinstance(x,dict):continue
      im=x.get("image")
      if isinstance(im,str):c.append(im)
      elif isinstance(im,list):c.extend([i if isinstance(i,str) else (i or {}).get("url") for i in im][:3])
      elif isinstance(im,dict) and im.get("url"):c.append(im["url"])
      for v in x.values():
        if isinstance(v,(dict,list)):stack.append(v)
  for m in re.finditer(r"<link\b[^>]*rel=[\"']image_src[\"'][^>]*>",html,re.I):
    v=attr(m.group(0),"href")
    if v:c.append(v)
  # Нет og:image — берём крупные картинки страницы (hero, галерея).
  if len(c)<2:
    for m in re.finditer(r"<img\b[^>]*>",html,re.I):
      tag=m.group(0)
      v=attr(tag,"data-src") or attr(tag,"data-lazy-src") or attr(tag,"src")
      if not v and attr(tag,"srcset"):v=attr(tag,"srcset").split(",")[-1].strip().split(" ")[0]
      if not v or v.startswith("data:"):continue
      if not re.search(r"\.(jpe?g|webp|png)(\?|$)",v,re.I):continue
      if BAD.search(v):continue
      c.append(v)
      if len(c)>=6:break
  out=[];s=set()
  for v in c:
    if not v:continue
    u=urljoin(base,v.strip())
    if u.startswith("//"):u="https:"+u
    if not u.startswith("http") or u in s:continue
    s.add(u);out.append(u)
  return out[:6]
def probe(img,ref):
  try:
    r=requests.get(img,headers={"User-Agent":UA,"Accept":"image/avif,image/webp,image/*;q=0.8","Referer":ref},timeout=10,stream=True,allow_redirects=True)
    ct=(r.headers.get("content-type") or "").split(";")[0].lower()
    if r.status_code!=200:return None,f"img_{r.status_code}"
    if not re.match(r"image/(jpeg|jpg|png|webp|gif|avif)",ct):return None,"img_type:"+ct
    buf=b""
    for chunk in r.iter_content(65536):
      buf+=chunk
      if len(buf)>1500000:break
    r.close()
    try:
      im=Image.open(io.BytesIO(buf));w,h=im.size
    except Exception:
      return None,"img_parse"
    return (w,h,ct,r.url),None
  except Exception as e:
    return None,"img_err"
def work(site):
  host=urlparse(site).hostname or ""
  if SKIP_HOST.search(host):return {"site":site,"err":"skip_host"}
  try:
    r=requests.get(site,headers=H,timeout=10,allow_redirects=True,stream=True)
    ct=(r.headers.get("content-type") or "").lower()
    if r.status_code>=400:return {"site":site,"err":f"http_{r.status_code}"}
    if "html" not in ct:return {"site":site,"err":"not_html"}
    buf=b""
    for chunk in r.iter_content(65536):
      buf+=chunk
      if len(buf)>400000:break
    r.close()
    html=buf.decode(r.encoding or "utf-8",errors="ignore")
    base=r.url
  except Exception as e:
    return {"site":site,"err":"fetch:"+type(e).__name__}
  cands=candidates(html,base)
  if not cands:return {"site":site,"err":"no_og"}
  last=None
  for c in cands:
    if BAD.search(urlparse(c).path or ""):last="bad_name";continue
    if re.search(r"\.svg($|\?)",c,re.I):last="svg";continue
    res,err=probe(c,base)
    if not res:last=err;continue
    w,h,ct,final=res
    if w<500 or h<280:last=f"small_{w}x{h}";continue
    if max(w/h,h/w)>2.6:last=f"aspect_{w}x{h}";continue
    return {"site":site,"img":c,"w":w,"h":h,"final":final}
  return {"site":site,"err":last or "none"}
n=0;ok=0;t0=time.time()
with ThreadPoolExecutor(WORKERS) as ex:
  futs=[ex.submit(work,s) for s in sites]
  for f in as_completed(futs):
    try:r=f.result()
    except Exception as e:continue
    with lock:
      out.write(json.dumps(r,ensure_ascii=False)+"\n");n+=1
      if "img" in r:ok+=1
      if n%500==0:out.flush();print(f"{n}/{len(sites)} фото {ok} ({round(100*ok/n)}%) {round(time.time()-t0)}с",flush=True)
out.close()
print("ГОТОВО",n,ok,flush=True)
