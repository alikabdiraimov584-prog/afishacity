# Выборочная проверка ссылок брони (из coverage.mjs): живы ли они.
#   python3 check_links.py <samples.json> <coverage.txt>   — дописывает итог в coverage.txt
import json,re,sys,requests
from urllib.parse import urlparse
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
S=json.load(open(sys.argv[1]));OUT=sys.argv[2]
lines=["","10 случайных ссылок брони (GET, 15 с):"]
ok=0
for b in S.get("booking",[]):
  u=b["url"]
  try:
    r=requests.get(u,headers={"User-Agent":UA,"Accept":"text/html"},timeout=15,allow_redirects=True,stream=True)
    buf=b""
    for c in r.iter_content(32768):
      buf+=c
      if len(buf)>150000:break
    r.close()
    txt=buf.decode("utf-8","ignore")
    t=re.search(r"<title[^>]*>(.*?)</title>",txt,re.I|re.S)
    title=re.sub(r"\s+"," ",t.group(1)).strip()[:70] if t else ""
    dead=r.status_code>=400 or re.search(r"page not found|404 not found|venue (?:is )?not found|no longer available",txt[:20000],re.I)
    v="OK" if not dead else "BAD"
    if r.status_code in (401,403,429) and urlparse(u).hostname and "sevenrooms" not in u:v="BLOCKED(bot)"
    if v=="OK":ok+=1
    lines.append(f"- {v} {r.status_code} {b['provider']}: {b['name']} → {u[:110]}" + (f" (→ {r.url[:80]})" if r.url!=u else "") + (f" «{title}»" if title else ""))
  except Exception as e:
    lines.append(f"- ERR {type(e).__name__} {b['provider']}: {b['name']} → {u[:110]}")
lines.append(f"Итог: живых {ok} из {len(S.get('booking',[]))}")
open(OUT,"a").write("\n".join(lines)+"\n")
print("\n".join(lines))
