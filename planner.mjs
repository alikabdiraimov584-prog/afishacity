// Серверная обёртка над изоморфным public/planner.js
import {CITY,LANG} from "./city.mjs";
// Язык и город для строк планировщика (сводка плана, поисковые фразы точек).
globalThis.FREE_LANG=LANG;globalThis.FREE_CITY_ID=CITY.id;globalThis.FREE_CITY_NAME=LANG==="en"?(CITY.nameEn||CITY.name):CITY.name;
await import("./public/planner.js");
const P=globalThis.FreePlanner;
export const {buildPlan,parseStops,planSummary,travel,guessCategory,yandexRouteUrl,googleRouteUrl,routeUrl,coordsPair}=P;
export default P;
