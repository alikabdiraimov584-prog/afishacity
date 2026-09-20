// Обложка места: последняя ступень каскада фотографий.
//
// Смысл файла — сделать независимость от внешних источников доказуемой, а не
// обещанной. Любая внешняя картинка может не найтись: у OpenStreetMap фотографий
// нет вовсе, сайт заведения может лежать, агрегатор — закрыть API. Поэтому снизу
// каскада стоит кадр, который мы рисуем сами из данных, уже находящихся в карточке:
// ноль сетевых запросов, ноль зависимостей, покрытие ровно 100%.
//
// Функция детерминирована: одно и то же место даёт один и тот же SVG, поэтому
// обложку можно кешировать навсегда и проверять снапшот-тестом без сети.
import {parseHours} from "./hours.mjs";

const W=1200,H=800;

// Палитра повторяет градиенты .placeMedia.noimg.c-* из public/index.html,
// чтобы обложка и запасной фон в интерфейсе выглядели одной вещью.
const PALETTE={
  bar:["#f3e7d3","#e6c9a8"], food:["#f6e3dc","#eebfb0"], hookah:["#e2e4ef","#c5c9de"],
  club:["#e9dcf3","#cbb6e4"], culture:["#dfeee6","#b9d9c8"], event:["#dde9f6","#b7cfea"],
  coffee:["#efe6dc","#d9c4ad"], active:["#e2f0ea","#bcdccb"], karaoke:["#f6e2ee","#ebbcd6"],
  spa:["#e6f0f2","#c0dade"], beauty:["#fbe6ef","#f0c3d8"], health:["#e4eef8","#bed6ee"],
  service:["#eceef1","#ccd2da"], shop:["#f5ecdf","#e2cdb0"], hotel:["#e7e6f4","#c6c3e6"],
  walk:["#e6f1e4","#c3ddbf"], other:["#eeeeec","#d6d6d2"]
};
// Тег категории справочника -> группа палитры. Неизвестное падает в other.
const GROUP={
  bar:"bar",winestore:"bar",nightlife:"club",club:"club",karaoke:"karaoke",
  food:"food",bakery:"food",pastry:"food",grocery:"shop",market:"shop",mall:"shop",
  coffee:"coffee",work:"coffee",
  hookah:"hookah",
  museum:"culture",gallery:"culture",library:"culture",planetarium:"culture",theatre:"culture",art:"culture",
  park:"walk",outdoors:"walk",zoo:"walk",
  bowling:"active",billiards:"active",quest:"active",vr:"active",shooting:"active",karting:"active",
  aquapark:"active",cinema:"culture",gym:"active",climbing:"active",icerink:"active",tennis:"active",pool:"active",
  spa:"spa",massage:"spa",yoga:"spa",
  barber:"beauty",nails:"beauty",cosmetology:"beauty",beauty:"beauty",tattoo:"beauty",
  clinic:"health",dentist:"health",pharmacy:"health",optics:"health",vet:"health",
  print:"service",bank:"service",post:"service",laundry:"service",tailor:"service",keys:"service",
  phonerepair:"service",photo:"service",legal:"service",carwash:"service",carrepair:"service",
  fuel:"service",parking:"service",petshop:"service",
  flowers:"shop",gifts:"shop",books:"shop",hotel:"hotel",
  family:"walk",courses:"culture"
};
const GLYPH={
  bar:"🍸",food:"🍽",hookah:"💨",club:"🪩",karaoke:"🎤",coffee:"☕",culture:"🖼",active:"🎳",
  spa:"🧖",beauty:"💈",health:"⚕",service:"🔧",shop:"🛍",hotel:"🛏",walk:"🌳",event:"🎟",other:"📍"
};

function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]))}
// Хеш названия: даёт стабильный оттенок, чтобы соседние карточки не сливались.
function hash(s){let h=2166136261;for(const ch of String(s||"")){h^=ch.codePointAt(0);h=Math.imul(h,16777619)}return (h>>>0)}

function hexToRgb(h){const m=/^#?([0-9a-f]{6})$/i.exec(String(h));if(!m)return {r:230,g:230,b:230};
  const n=parseInt(m[1],16);return {r:(n>>16)&255,g:(n>>8)&255,b:n&255}}
function rgbToHex({r,g,b}){const c=v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,"0");return `#${c(r)}${c(g)}${c(b)}`}
function rgbToHsl({r,g,b}){
  r/=255;g/=255;b/=255;
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2;
  if(mx===mn)return {h:0,s:0,l};
  const d=mx-mn,s=l>.5?d/(2-mx-mn):d/(mx+mn);
  const h=mx===r?((g-b)/d+(g<b?6:0)):mx===g?((b-r)/d+2):((r-g)/d+4);
  return {h:h*60,s,l};
}
function hslToRgb({h,s,l}){
  h=((h%360)+360)%360;
  if(s===0){const v=l*255;return {r:v,g:v,b:v}}
  const q=l<.5?l*(1+s):l+s-l*s,p=2*l-q;
  const f=t=>{t=((t%1)+1)%1;
    if(t<1/6)return p+(q-p)*6*t;
    if(t<1/2)return q;
    if(t<2/3)return p+(q-p)*(2/3-t)*6;
    return p};
  return {r:f(h/360+1/3)*255,g:f(h/360)*255,b:f(h/360-1/3)*255};
}
// Небольшой сдвиг тона по хешу названия — в пределах, где палитра остаётся узнаваемой.
function shift(hex,deg,dl){const c=rgbToHsl(hexToRgb(hex));return rgbToHex(hslToRgb({h:c.h+deg,s:c.s,l:Math.max(.16,Math.min(.95,c.l+dl))}))}

export function coverGroup(tags=[],category=""){
  for(const t of tags)if(GROUP[t])return GROUP[t];
  const n=String(category||"").toLowerCase();
  if(/бар|паб/.test(n))return "bar";
  if(/ресторан|кафе|кухн|столов/.test(n))return "food";
  if(/кальян/.test(n))return "hookah";
  if(/клуб/.test(n))return "club";
  if(/музе|галере|театр|выстав/.test(n))return "culture";
  if(/парк|сад|сквер/.test(n))return "walk";
  if(/аптек|клиник|стоматолог/.test(n))return "health";
  if(/салон|парикмахер|барбер/.test(n))return "beauty";
  if(/отел|хостел|гостиниц/.test(n))return "hotel";
  return "other";
}

// Перенос по словам: в SVG нет автопереноса, ширину считаем по средней доле em.
// Для кириллицы в плотном гротеске это около 0.52 em.
export function wrapLines(text,maxChars,maxLines){
  const words=String(text||"").trim().split(/\s+/).filter(Boolean);
  const lines=[];let cur="";
  for(const w of words){
    const next=cur?cur+" "+w:w;
    if(next.length<=maxChars){cur=next;continue}
    if(cur)lines.push(cur);
    // Слово длиннее строки целиком — рвём его, иначе вылезет за край.
    if(w.length>maxChars){
      let rest=w;
      while(rest.length>maxChars&&lines.length<maxLines){lines.push(rest.slice(0,maxChars-1)+"­");rest=rest.slice(maxChars-1)}
      cur=rest;
    }else cur=w;
    if(lines.length>=maxLines)break;
  }
  if(cur&&lines.length<maxLines)lines.push(cur);
  if(lines.length>maxLines)lines.length=maxLines;
  const joined=lines.join(" ").length, total=String(text||"").trim().length;
  if(lines.length===maxLines&&joined<total){
    const last=lines[maxLines-1];
    lines[maxLines-1]=last.length>3?last.slice(0,Math.max(1,maxChars-1))+"…":last+"…";
  }
  return lines;
}

// Положение относительно центра Москвы. Настоящих тайлов мы не рисуем: Tile Usage
// Policy запрещает их систематическое использование, а рисовать улицы нам не из чего.
// Вместо этого — честная схема: Кремль, Садовое кольцо, МКАД и точка места.
const KREMLIN={lat:55.7539,lon:37.6208};
function locDot(coords){
  if(!coords)return null;
  const lat=Number(coords.lat??coords.latitude),lon=Number(coords.lon??coords.lng??coords.longitude);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;
  // Плоская аппроксимация: на масштабе города искажение пренебрежимо.
  const kmLat=111.32,kmLon=111.32*Math.cos(KREMLIN.lat*Math.PI/180);
  return {x:(lon-KREMLIN.lon)*kmLon,y:-(lat-KREMLIN.lat)*kmLat};
}

function statusLine(hoursLabel,now){
  const h=parseHours(hoursLabel,now);
  if(!h||h.open_now===null||h.open_now===undefined)return null;
  if(h.open_now)return {text:h.closes_at?`Открыто · до ${h.closes_at}`:"Открыто сейчас",tone:"#146c43"};
  return {text:h.opens_at?`Закрыто · откроется в ${h.opens_at}`:"Сейчас закрыто",tone:"#8a6410"};
}

/**
 * Рисует обложку места. Все данные приходят из уже собранной карточки —
 * функция ничего не запрашивает и не зависит от текущего времени, если now передан.
 */
export function renderCover({name="Место",category="",tags=[],area="",metro="",hours_label="",price_label="",coords=null,kind="venue",now=new Date()}={}){
  const group=kind==="event"&&!tags.length?"event":coverGroup(tags,category);
  const [c1,c2]=PALETTE[group]||PALETTE.other;
  const seed=hash(name+"|"+group);
  const deg=(seed%25)-12, dl=((seed>>5)%9)/100-.04;
  const top=shift(c1,deg,dl), bottom=shift(c2,deg,dl-.02);
  const gid=`fc${seed.toString(36)}`;
  const ink=rgbToHsl(hexToRgb(bottom)).l>.5?"#14181d":"#ffffff";
  const soft=rgbToHsl(hexToRgb(bottom)).l>.5?"rgba(20,24,29,.58)":"rgba(255,255,255,.72)";

  const lines=wrapLines(name,22,3);
  const size=lines.length>=3?62:lines.length===2?74:86;
  // Композиция собирается снизу вверх: чипы на фиксированной высоте, название
  // прижато к ним сверху. Так однострочное и трёхстрочное имя дают одинаковый ритм,
  // а надпись «МЕСТО» никогда не налезает на крупный заголовок.
  const chipsY=H-250;
  const nameTop=chipsY-46-(lines.length-1)*size;
  const eyebrowY=nameTop-size-26;

  const chips=[category,area||metro,price_label].map(x=>String(x||"").trim()).filter(Boolean).slice(0,3);
  const st=statusLine(hours_label,now);
  const dot=locDot(coords);

  // Схема расположения: кольца в километрах, масштаб 20 км на радиус диска.
  const mapR=86,scale=mapR/20;
  let mapSvg="";
  if(dot){
    const d=Math.hypot(dot.x,dot.y);
    const k=d>20?20/d:1;                                   // за МКАД — прижимаем к краю
    const px=dot.x*k*scale, py=dot.y*k*scale;
    mapSvg=`<g transform="translate(${W-150} ${H-150})" opacity=".92">
      <circle r="${mapR}" fill="rgba(255,255,255,.34)" stroke="${soft}" stroke-width="1.5"/>
      <circle r="${(17*scale).toFixed(1)}" fill="none" stroke="${soft}" stroke-width="1" stroke-dasharray="4 5" opacity=".7"/>
      <circle r="${(2.5*scale).toFixed(1)}" fill="none" stroke="${soft}" stroke-width="1" opacity=".7"/>
      <circle r="2.5" fill="${soft}"/>
      <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="9" fill="${ink}" opacity=".18"/>
      <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5.5" fill="${ink}"/>
      <text x="0" y="${mapR+22}" text-anchor="middle" font-size="16" fill="${soft}"
        font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Arial,sans-serif">${esc(d<1?"в центре":d.toFixed(1)+" км от центра")}</text>
    </g>`;
  }

  // Правый нижний угол занят схемой, туда чипы заезжать не должны.
  const chipLimit=coords?W-300:W-72;
  const chipSvg=chips.map((c,i)=>{
    const w=Math.min(420,c.length*11.5+34),x=72+(i?chips.slice(0,i).reduce((a,p)=>a+Math.min(420,p.length*11.5+34)+12,0):0);
    if(x+w>chipLimit)return "";
    return `<g transform="translate(${x} ${chipsY})">
      <rect rx="17" ry="17" width="${w.toFixed(0)}" height="34" fill="rgba(255,255,255,.52)" stroke="${soft}" stroke-width="1"/>
      <text x="17" y="23" font-size="17" fill="${ink}" opacity=".82"
        font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Arial,sans-serif">${esc(c)}</text></g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(name)}">
<defs>
  <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
  </linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#${gid})"/>
<text x="72" y="118" font-size="112" opacity=".22">${esc(GLYPH[group]||GLYPH.other)}</text>
<text x="72" y="${eyebrowY}" font-size="19" letter-spacing="3.2" fill="${soft}"
  font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Arial,sans-serif">${esc(kind==="event"?"СОБЫТИЕ":"МЕСТО")}</text>
${lines.map((l,i)=>`<text x="72" y="${nameTop+i*size}" font-size="${size}" font-weight="700" fill="${ink}" letter-spacing="-1.4"
  font-family="-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Arial,sans-serif">${esc(l)}</text>`).join("\n")}
${chipSvg}
${st?`<g transform="translate(72 ${H-108})">
  <circle cx="7" cy="-6" r="7" fill="${st.tone}"/>
  <text x="26" y="0" font-size="24" fill="${ink}" opacity=".9"
    font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Arial,sans-serif">${esc(st.text)}</text></g>`:""}
<text x="72" y="${H-54}" font-size="15" fill="${soft}"
  font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Arial,sans-serif">Схема © OpenStreetMap contributors (ODbL)</text>
${mapSvg}
</svg>`;
}

export const COVER_SIZE={width:W,height:H};
