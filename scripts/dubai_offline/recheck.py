# Повторная проверка уже помеченных сайтов уточнёнными правилами (без ложных
# «mousedown» → sedo и «Al Bandar Rotana» → bandar).
import json,re,requests
from concurrent.futures import ThreadPoolExecutor
src=open("spam.py").read()
SPAM=eval(re.search(r"SPAM=(re\.compile\(.*?\))\n",src).group(1))
PARKED=eval(re.search(r"PARKED=(re\.compile\(.*?\))\n",src).group(1))
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
res=json.load(open("site_check.json"))
bad=[s for s,v in res.items() if v["v"] in("spam","parked")]
def chk(site):
  try:
    r=requests.get(site,headers={"User-Agent":UA,"Accept":"text/html"},timeout=15,stream=True)
    buf=b""
    for c in r.iter_content(65536):
      buf+=c
      if len(buf)>200000:break
    head=buf.decode("utf-8","ignore")[:60000]
    t=re.search(r"<title[^>]*>(.*?)</title>",head,re.I|re.S);title=(t.group(1).strip()[:120] if t else "")
    if SPAM.search(head):return site,{"v":"spam","final":r.url,"title":title,"m":SPAM.search(head).group(0)}
    m=PARKED.search(head) or PARKED.search(r.url)
    if m:return site,{"v":"parked","final":r.url,"title":title,"m":m.group(0)}
    return site,{"v":"ok","final":r.url,"title":title}
  except Exception:
    return site,{"v":"fail","final":None}
with ThreadPoolExecutor(48) as ex:
  for s,v in ex.map(chk,bad):res[s]=v
json.dump(res,open("site_check.json","w"))
from collections import Counter
print(Counter(res[s]["v"] for s in bad))
