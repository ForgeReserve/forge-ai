// All text comes from one string table, so a later slice can translate it. A string may hold named
// slots such as {amount}; text is never built by joining fragments.
import en from '../strings/en.js';

let table = en;

export function setTable(t) {
  table = t;
}

export function t(key, params) {
  const s = table[key] ?? en[key];
  if (s == null) throw new Error(`missing string ${key}`);
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : '')) : s;
}

export const has = (key) => key in table || key in en;
