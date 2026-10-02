import json,re,sys,io,os,requests
from urllib.parse import urljoin,urlparse
from PIL import Image
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
H={"User-Agent":UA,"Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8","Accept-Language":"en-US,en;q=0.9","Upgrade-Insecure-Requests":"1","Sec-Fetch-Mode":"navigate","Sec-Fetch-Site":"none","Sec-Fetch-Dest":"document"}
BAD=re.compile(r"logo|sprite|placeholder|favicon|\bicons?\b|/icons?/|noimage|no-image|no_image|avatar|blank|spacer|pixel|badge|apple-touch|qr-?code|default-(?:og|share|image)|og-default|share-default|loader|loading",re.I)
SKIP_HOST=re.compile(r"(^|\.)(google\.|goo\.gl|facebook\.com|fb\.com|wa\.me|whatsapp\.com|t\.me|tiktok\.com|youtube\.com|twitter\.com|x\.com|snapchat\.com|maps\.app\.goo\.gl|bit\.ly)",re.I)
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
    r=requests.get(img,headers={"User-Agent":UA,"Accept":"image/avif,image/webp,image/*;q=0.8","Referer":ref},timeout=20,stream=True,allow_redirects=True)
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
  r=_work(site)
  if "img" not in r and r.get("err","").startswith(("http_403","http_404","http_410","no_og","fetch")):
    u=urlparse(site);root=f"{u.scheme}://{u.hostname}/"
    if root!=site and u.hostname:
      r2=_work(root)
      if "img" in r2:r2["site"]=site;r2["via"]=root;return r2
  return r
def _work(site):
  host=urlparse(site).hostname or ""
  if SKIP_HOST.search(host):return {"site":site,"err":"skip_host"}
  try:
    r=requests.get(site,headers=H,timeout=20,allow_redirects=True,stream=True)
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
    if w<400 or h<225:last=f"small_{w}x{h}";continue
    if max(w/h,h/w)>2.6:last=f"aspect_{w}x{h}";continue
    return {"site":site,"img":c,"w":w,"h":h,"final":final}
  return {"site":site,"err":last or "none"}
