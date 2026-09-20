// Разбор .env своими силами. systemd отдаёт EnvironmentFile строго как
// КЛЮЧ=значение и молча выбрасывает всё остальное: строка с голым токеном или
// случайно вставленная команда просто исчезают, и ключ не доезжает до сервера.
// Здесь мы читаем тот же файл сами и называем номера пропущенных строк.
import {readFileSync} from "node:fs";

export function parseDotenv(text){
  const vars=new Map(), bad=[];
  String(text).split(/\r?\n/).forEach((raw,i)=>{
    const line=raw.trim();
    if(!line||line.startsWith("#"))return;
    const eq=line.indexOf("=");
    const key=eq>0?line.slice(0,eq).replace(/^export\s+/,"").trim():"";
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)){bad.push(i+1);return}
    let val=line.slice(eq+1).trim();
    const q=val[0];
    if((q==='"'||q==="'")&&val.length>1&&val.endsWith(q))val=val.slice(1,-1);
    vars.set(key,val);
  });
  return {vars,bad};
}

// Значения из окружения важнее файла: systemd, docker и `KEY=... node server.mjs`
// должны перебивать .env, поэтому заполняем только пустые ключи.
export function loadDotenv(file,env=process.env){
  let text;
  try{text=readFileSync(file,"utf8")}catch{return {loaded:[],bad:[]}}
  const {vars,bad}=parseDotenv(text), loaded=[];
  for(const [key,val] of vars)if(!env[key]){env[key]=val;loaded.push(key)}
  return {loaded,bad};
}
