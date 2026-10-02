# Отличить фотографию от логотипа/плаката: у графики мало цветов и большие
# заливки одного цвета, у фото — тысячи оттенков без доминирующей заливки.
import io
from PIL import Image,ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES=True
def metrics(buf):
  im=Image.open(io.BytesIO(buf));im.load()
  if im.mode in("P","LA","RGBA") and "transparency" in im.info or im.mode in("RGBA","LA"):
    a=im.convert("RGBA").getchannel("A").resize((32,32))
    transparent=sum(1 for p in a.getdata() if p<200)/1024
  else: transparent=0.0
  sm=im.convert("RGB").resize((64,64))
  q=[(r>>4,g>>4,b>>4) for r,g,b in sm.getdata()]
  from collections import Counter
  c=Counter(q);n=len(q)
  top=c.most_common(3)
  return {"uniq":len(c),"top1":round(top[0][1]/n,3),"top3":round(sum(x[1] for x in top)/n,3),"transp":round(transparent,3)}
def is_photo(m):
  if m["transp"]>0.05:return False
  if m["uniq"]<150:return False
  if m["top1"]>0.30:return False
  if m["top3"]>0.45:return False
  return True

def feats2(buf):
  im=Image.open(io.BytesIO(buf));im.load()
  transparent=0.0
  if im.mode in("RGBA","LA") or (im.mode=="P" and "transparency" in im.info):
    a=im.convert("RGBA").getchannel("A").resize((32,32))
    transparent=sum(1 for p in a.getdata() if p<200)/1024
  im=im.convert("RGB").resize((96,96))
  px=list(im.getdata())
  u6=len({(r>>2,g>>2,b>>2) for r,g,b in px})
  gp=list(im.convert("L").getdata());flat=0
  for i in range(96*95):
    if abs(gp[i]-gp[i+96])<=2 and (i%96==95 or abs(gp[i]-gp[i+1])<=2):flat+=1
  return {"u6":u6,"flat":round(flat/(96*95),3),"transp":round(transparent,3)}
def is_photo2(f):
  if f["transp"]>0.05:return False
  if f["flat"]>=0.62:return False
  if f["u6"]<250 and f["flat"]>=0.3:return False
  return True
