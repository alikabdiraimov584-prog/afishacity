# Отсев рекламных картинок: на фото места почти нет текста, на плакате — много.
import json,os,io,subprocess,requests,re
from concurrent.futures import ThreadPoolExecutor,as_completed
from PIL import Image,ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES=True
qa=json.load(open("site_photos_qa2.json"))
out=json.load(open("site_photos_ocr.json")) if os.path.exists("site_photos_ocr.json") else {}
todo=[u for u,v in qa.items() if v.get("ok") and u not in out]
print("к распознаванию",len(todo),flush=True)
GAMBLE=re.compile(r"slot|gacor|casino|judi|togel|jackpot|maxwin|deposit|bonus|scatter",re.I)
def run(u):
  k=qa[u].get("k")
  p=f"vthumbs2/{k}.jpg"
  try:
    r=requests.get(u,timeout=20,headers={"User-Agent":"Mozilla/5.0"})
    im=Image.open(io.BytesIO(r.content)).convert("L");im.thumbnail((900,900))
    tmp=f"/tmp/ocr_{k}.png";im.save(tmp)
    tsv=subprocess.run(["tesseract",tmp,"-","--psm","11","tsv"],capture_output=True,text=True,timeout=60).stdout
    os.remove(tmp)
    words=[]
    for line in tsv.splitlines()[1:]:
      c=line.split("\t")
      if len(c)<12:continue
      try:conf=float(c[10])
      except:continue
      w=c[11].strip()
      if conf>=75 and len(re.sub(r"[^A-Za-z0-9]","",w))>=3:words.append(w)
    txt=" ".join(words)
    return u,{"n":len(words),"text":txt[:200],"gamble":bool(GAMBLE.search(txt))}
  except Exception as e:
    return u,{"n":-1}
n=0
with ThreadPoolExecutor(12) as ex:
  for f in as_completed([ex.submit(run,u) for u in todo]):
    u,v=f.result();out[u]=v;n+=1
    if n%500==0:json.dump(out,open("site_photos_ocr.json","w"));print(n,flush=True)
json.dump(out,open("site_photos_ocr.json","w"))
print("ГОТОВО",len(out),"с текстом ≥6 слов",sum(1 for v in out.values() if v.get("n",0)>=6),flush=True)
