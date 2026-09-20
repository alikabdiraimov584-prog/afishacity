/* FREE share card: рисует карточку плана вечера на canvas (как Strava — картинка с итогами и схемой маршрута).
   window.FreeShareCard.render(plan, {title, date}) → Promise<Blob PNG 1080×1350>. */
(function(root){
"use strict";
const W=1080,H=1350;
const CAT_EMOJI={bar:"🍸",food:"🍽️",hookah:"💨",club:"🪩",karaoke:"🎤",coffee:"☕",culture:"🖼️",active:"🎳",spa:"🧖",walk:"🌳",event:"🎟️",other:"📍"};
function guess(text){const P=root.FreePlanner;return P?P.guessCategory(text):"other"}
function coords(c){const P=root.FreePlanner;return P?P.coordsPair(c):null}
function ellipsis(ctx,text,max){text=String(text||"");if(ctx.measureText(text).width<=max)return text;let t=text;while(t.length>1&&ctx.measureText(t+"…").width>max)t=t.slice(0,-1);return t+"…"}
function rr(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
function drawRoute(ctx,stops,x,y,w,h){
  const pts=stops.map(s=>s.place&&coords(s.place.coords)).filter(Boolean);
  rr(ctx,x,y,w,h,28);ctx.fillStyle="#f1f1ee";ctx.fill();
  if(pts.length<2){ // без координат — цепочка категорий вечера
    const ems=stops.map(s=>CAT_EMOJI[s.place?guess([s.place.category,s.place.name].join(" ")):guess(s.query)]||"📍");
    const step=Math.min(230,(w-120)/Math.max(1,ems.length));const startX=x+w/2-((ems.length-1)*step)/2;
    ems.forEach((em,i)=>{const px=startX+i*step,py=y+h/2;
      if(i){ctx.strokeStyle="rgba(20,24,28,.22)";ctx.lineWidth=5;ctx.setLineDash([3,12]);ctx.beginPath();ctx.moveTo(px-step+62,py);ctx.lineTo(px-62,py);ctx.stroke();ctx.setLineDash([])}
      ctx.beginPath();ctx.arc(px,py,58,0,Math.PI*2);ctx.fillStyle="#fff";ctx.fill();ctx.lineWidth=3;ctx.strokeStyle="rgba(20,24,28,.1)";ctx.stroke();
      ctx.font="58px -apple-system,'Apple Color Emoji','Segoe UI Emoji',sans-serif";ctx.textAlign="center";ctx.fillStyle="#111";ctx.fillText(em,px,py+21);ctx.textAlign="left"});
    return}
  const lats=pts.map(p=>p.lat),lons=pts.map(p=>p.lon);
  const minLat=Math.min(...lats),maxLat=Math.max(...lats),minLon=Math.min(...lons),maxLon=Math.max(...lons);
  const pad=70;const kx=Math.cos(((minLat+maxLat)/2)*Math.PI/180);
  const spanX=Math.max((maxLon-minLon)*kx,0.002),spanY=Math.max(maxLat-minLat,0.002);
  const scale=Math.min((w-pad*2)/spanX,(h-pad*2)/spanY);
  const cx=x+w/2,cy=y+h/2;
  const P=pts.map(p=>({x:cx+((p.lon-(minLon+maxLon)/2)*kx)*scale,y:cy-((p.lat-(minLat+maxLat)/2))*scale}));
  ctx.lineWidth=10;ctx.lineCap="round";ctx.lineJoin="round";ctx.strokeStyle="#111316";
  ctx.beginPath();P.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
  P.forEach((p,i)=>{ctx.beginPath();ctx.arc(p.x,p.y,22,0,Math.PI*2);ctx.fillStyle="#fff";ctx.fill();ctx.lineWidth=6;ctx.strokeStyle="#111316";ctx.stroke();ctx.fillStyle="#111316";ctx.font="700 22px -apple-system,Inter,Arial,sans-serif";ctx.textAlign="center";ctx.fillText(String(i+1),p.x,p.y+8);ctx.textAlign="left"});
}
async function render(plan,opts={}){
  const c=document.createElement("canvas");c.width=W;c.height=H;const ctx=c.getContext("2d");
  const stops=(plan.stops||[]).slice(0,4);
  // фон
  ctx.fillStyle="#f6f6f4";ctx.fillRect(0,0,W,H);
  const g=ctx.createRadialGradient(W/2,-100,50,W/2,-100,900);g.addColorStop(0,"rgba(255,255,255,.9)");g.addColorStop(1,"rgba(255,255,255,0)");ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  // шапка
  ctx.fillStyle="#111316";ctx.font="800 44px -apple-system,Inter,Arial,sans-serif";ctx.fillText("FREE",72,110);
  ctx.fillStyle="#727780";ctx.font="600 26px -apple-system,Inter,Arial,sans-serif";ctx.letterSpacing="4px";ctx.fillText("ПЛАН ВЕЧЕРА",72,160);ctx.letterSpacing="0px";
  const dateLabel=opts.date||"";
  if(dateLabel){ctx.textAlign="right";ctx.fillStyle="#727780";ctx.font="600 28px -apple-system,Inter,Arial,sans-serif";ctx.fillText(dateLabel,W-72,110);ctx.textAlign="left"}
  ctx.fillStyle="#111214";ctx.font="800 72px -apple-system,Inter,Arial,sans-serif";
  const t=plan.total||{};
  ctx.fillText(ellipsis(ctx,opts.title||`${t.start||""}–${t.end||""}`,W-144),72,250);
  // схема маршрута
  const routeH=stops.length>3?230:300;
  drawRoute(ctx,stops,72,300,W-144,routeH);
  // таймлайн: высота строки подбирается так, чтобы всё поместилось над панелью итогов
  const statsTop=H-250;
  let y=300+routeH+80;
  const rowH=Math.min(160,Math.max(96,(statsTop-40-y)/Math.max(1,stops.length)));
  stops.forEach((s,i)=>{
    const p=s.place;
    ctx.fillStyle="#111214";ctx.font="700 34px -apple-system,Inter,Arial,sans-serif";ctx.fillText(s.slot_start||"",72,y);
    ctx.fillStyle="#9a9ea6";ctx.font="500 24px -apple-system,Inter,Arial,sans-serif";ctx.fillText(s.slot_end?"–"+s.slot_end:"",72,y+34);
    const emoji=CAT_EMOJI[p?guess([p.category,p.name].join(" ")):guess(s.query)]||"📍";
    rr(ctx,250,y-46,68,68,20);ctx.fillStyle="#fff";ctx.fill();ctx.strokeStyle="rgba(20,24,28,.1)";ctx.lineWidth=2;ctx.stroke();
    ctx.font="34px -apple-system,'Apple Color Emoji','Segoe UI Emoji',sans-serif";ctx.fillStyle="#111";ctx.textAlign="center";ctx.fillText(emoji,284,y+1);ctx.textAlign="left";
    ctx.fillStyle="#111214";ctx.font="700 38px -apple-system,Inter,Arial,sans-serif";ctx.fillText(ellipsis(ctx,p?p.name:(s.query+" — не найдено"),W-72-340),340,y);
    ctx.fillStyle="#727780";ctx.font="500 26px -apple-system,Inter,Arial,sans-serif";ctx.fillText(ellipsis(ctx,p?[p.category,p.metro?"м. "+p.metro:p.area].filter(Boolean).join(" · "):"",W-72-340),340,y+38);
    if(s.travel_to_next){const tr=s.travel_to_next;const lab=(tr.mode==="walk"?"пешком":tr.mode==="taxi"?"такси":"переход")+" ~"+tr.minutes+" мин"+(tr.km?" · "+tr.km+" км":"");
      ctx.strokeStyle="rgba(20,24,28,.18)";ctx.lineWidth=3;ctx.setLineDash([2,10]);ctx.beginPath();ctx.moveTo(284,y+36);ctx.lineTo(284,y+rowH-52);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle="#9a9ea6";ctx.font="500 24px -apple-system,Inter,Arial,sans-serif";ctx.fillText("↓ "+lab,340,y+Math.max(78,rowH-56))}
    y+=rowH;
  });
  // итог
  const stats=[[`${t.start||"–"}–${t.end||"–"}`,"время"],[String(t.found??stops.length),"точек"],[t.travel_km?`${t.travel_km} км`:"—","переходы"],[t.price_from?`от ${Number(t.price_from).toLocaleString("ru-RU")} ₽`:"по меню","бюджет"]];
  const by=H-250;rr(ctx,72,by,W-144,150,28);ctx.fillStyle="#111316";ctx.fill();
  const cols=[1.45,0.75,1.0,1.2],total=cols.reduce((a,b)=>a+b,0),inner=W-144-80;let sx=72+40;
  stats.forEach(([v,l],i)=>{const cw=inner*cols[i]/total;ctx.fillStyle="#fff";ctx.font="800 34px -apple-system,Inter,Arial,sans-serif";ctx.fillText(ellipsis(ctx,v,cw-16),sx,by+70);ctx.fillStyle="rgba(255,255,255,.55)";ctx.font="600 22px -apple-system,Inter,Arial,sans-serif";ctx.fillText(l.toUpperCase(),sx,by+108);sx+=cw});
  ctx.fillStyle="#9a9ea6";ctx.font="600 24px -apple-system,Inter,Arial,sans-serif";ctx.fillText("Собрано в FREE · не ищите, разговаривайте",72,H-52);
  if(opts.host){ctx.textAlign="right";ctx.fillText(opts.host,W-72,H-52);ctx.textAlign="left"}
  return new Promise(res=>c.toBlob(b=>res(b),"image/png"));
}
root.FreeShareCard={render};
})(typeof globalThis!=="undefined"?globalThis:this);
