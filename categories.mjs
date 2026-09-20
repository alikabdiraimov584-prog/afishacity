// Серверная обёртка над изоморфным public/categories.js
await import("./public/categories.js");
const C=globalThis.FreeCategories;
export const {CATEGORIES,CATEGORY_MATCHERS,SERVICE_TAGS,categoryTags}=C;
export default C;
