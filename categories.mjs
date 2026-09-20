// Серверная обёртка над изоморфным public/categories.js
await import("./public/categories.js");
const C=globalThis.FreeCategories;
export const {CATEGORIES,CATEGORY_MATCHERS,categoryTags}=C;
export default C;
