// Собирает веб-часть приложения в app/www: копирует public/ и подставляет адрес API.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync,statSync} from "node:fs";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const cfg=JSON.parse(readFileSync(join(root,"app","app.config.json"),"utf8"));
const apiBase=String(process.env.FREE_API_BASE||cfg.apiBase||"").replace(/\/+$/,"");
if(!/^https?:\/\//.test(apiBase))throw new Error("app/app.config.json: apiBase должен быть абсолютным URL, например https://afishasity.ru");
const out=join(root,"app","www");mkdirSync(out,{recursive:true});
for(const f of readdirSync(join(root,"public"))){const p=join(root,"public",f);if(statSync(p).isFile()&&f!=="index.html")copyFileSync(p,join(out,f))}
let html=readFileSync(join(root,"public","index.html"),"utf8");
const inject=`<script>window.FREE_CONFIG=${JSON.stringify({apiBase,app:true,builtAt:new Date().toISOString()})};</script>\n<script src="planner.js"></script>`;
if(!html.includes(`<script src="planner.js"></script>`))throw new Error("не нашёл подключение planner.js");
html=html.replace(`<script src="planner.js"></script>`,inject);
writeFileSync(join(out,"index.html"),html);
console.log(`app/www собран, API: ${apiBase}`);
