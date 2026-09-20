// Серверная обёртка над изоморфным public/planner.js
await import("./public/planner.js");
const P=globalThis.FreePlanner;
export const {buildPlan,parseStops,planSummary,travel,guessCategory,yandexRouteUrl,coordsPair}=P;
export default P;
