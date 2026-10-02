# Захваченный сайт — это когда казино в заголовке или описании страницы.
# Ссылка-вставка где-то в коде настоящего сайта (Barakat Optical, Mori Sushi)
# — сайт взломан, но он всё ещё сайт заведения: ссылку оставляем.
import json,re,requests,html as H
from concurrent.futures import ThreadPoolExecutor
src=open("spam.py").read()
SPAM=eval(re.search(r"SPAM=(re\.compile\(.*?\))\n",src).group(1))
EXTRA=re.compile(r"(كازينو|казино|вавада|vavada|สล็อต|บาคาร่า|game bài|đổi thưởng|live draw|result sdy|^\W*[a-z]{3,}\d{2,3}\b|\bjackpot\b|\bjudi\b|\btoto\b)",re.I)
# Казино в заголовке страницы — сайт уже не заведения. Кроме сетей, у которых
# казино — часть дела (Hard Rock).
TITLE_BAD=re.compile(r"(casinos?|pokies|cược|\w+(?:bet|toto|slot)\b|situs|\bslots?\b|deposit)",re.I)
LEGIT_CASINO=re.compile(r"hardrock\.com",re.I)
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
res=json.load(open("site_check.json"))
bad=[s for s,v in res.items() if v["v"]=="spam"]
def meta(head):
  t=re.search(r"<title[^>]*>(.*?)</title>",head,re.I|re.S)
  d=re.search(r"<meta[^>]+name=[\"']description[\"'][^>]*content=[\"']([^\"']*)",head,re.I) or re.search(r"<meta[^>]+content=[\"']([^\"']*)[\"'][^>]*name=[\"']description",head,re.I)
  o=re.search(r"<meta[^>]+property=[\"']og:title[\"'][^>]*content=[\"']([^\"']*)",head,re.I)
  return H.unescape((t.group(1) if t else "")+" || "+(d.group(1) if d else "")+" || "+(o.group(1) if o else "")).strip()
def chk(site):
  try:
    r=requests.get(site,headers={"User-Agent":UA,"Accept":"text/html"},timeout=15,stream=True)
    buf=b""
    for c in r.iter_content(65536):
      buf+=c
      if len(buf)>200000:break
    m=meta(buf.decode("utf-8","ignore")[:60000])
    title=m.split(" || ")[0].strip()
    hit=SPAM.search(m) or EXTRA.search(title) or EXTRA.search(m.split(" || ")[1] if " || " in m else "") or (TITLE_BAD.search(title) and not LEGIT_CASINO.search(site))
    return site,("spam" if hit else "injected"),m[:200]
  except Exception:return site,"keep",""
with ThreadPoolExecutor(48) as ex:out=list(ex.map(chk,bad))
from collections import Counter
print(Counter(v for _,v,_ in out))
for s,v,m in out:
  if v!="spam":print(v,"|",s[:45],"|",m[:110])
for s,v,m in out:
  res[s]["v"]="spam" if v=="spam" else ("injected" if v=="injected" else res[s]["v"])
  res[s]["meta"]=m
json.dump(res,open("site_check.json","w"))
