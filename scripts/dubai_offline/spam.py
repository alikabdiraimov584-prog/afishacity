# Захваченные и припаркованные домены: на месте сайта заведения — казино,
# «слоты», продажа домена. Такую ссылку человеку давать нельзя.
import json,re,sqlite3,sys,threading,time,requests
from concurrent.futures import ThreadPoolExecutor,as_completed
DB=sys.argv[1];OUT=sys.argv[2]
SPAM=re.compile(r"\b(slot ?gacor|slot online|slot88|situs (?:slot|judi|togel|toto|bola)|judi (?:online|bola)|togel|casino online|online casino|live casino|sbobet|maxwin|bandar (?:togel|slot|judi|toto|bola|casino)|poker online|sportsbook|bet(?:ting)? online|deposit pulsa|rtp live|toto ?macau|akun pro|gacor|scatter hitam|mahjong ways|pragmatic play)\b",re.I)
PARKED=re.compile(r"(domain (?:is )?for sale|buy this domain|this domain (?:may be|is) for sale|hugedomains|(?<![\w.-])dan\.com\b|(?<![\w.-])sedo\.com\b|sedoparking|parkingcrew|(?<![\w.-])bodis\.com\b|domain has expired|this domain has expired|godaddy\.com/domainsearch|afternic|undeveloped\.com|domain parking|errorCode: ?'ConnectYourDomain')",re.I)
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
db=sqlite3.connect(DB);sites=set()
for (tj,) in db.execute("select tags_json from place"):
  t=json.loads(tj);s=(t.get("website") or t.get("contact:website") or t.get("url") or "").strip()
  if s:sites.add(s if "://" in s else "http://"+s)
print("сайтов",len(sites),flush=True)
def chk(site):
  try:
    r=requests.get(site,headers={"User-Agent":UA,"Accept":"text/html"},timeout=15,stream=True,allow_redirects=True)
    buf=b""
    for c in r.iter_content(65536):
      buf+=c
      if len(buf)>200000:break
    r.close()
    html=buf.decode("utf-8","ignore")
    head=html[:60000]
    if SPAM.search(head):return site,"spam",r.url
    if PARKED.search(head) or PARKED.search(r.url):return site,"parked",r.url
    return site,"ok",r.url
  except Exception as e:
    return site,"fail",None
res={};n=0
with ThreadPoolExecutor(64) as ex:
  for f in as_completed([ex.submit(chk,s) for s in sites]):
    s,v,u=f.result();res[s]={"v":v,"final":u};n+=1
    if n%2000==0:print(n,sum(1 for x in res.values() if x["v"]=="spam"),sum(1 for x in res.values() if x["v"]=="parked"),flush=True)
json.dump(res,open(OUT,"w"))
print("ГОТОВО спам",sum(1 for x in res.values() if x["v"]=="spam"),"припаркованы",sum(1 for x in res.values() if x["v"]=="parked"),flush=True)
