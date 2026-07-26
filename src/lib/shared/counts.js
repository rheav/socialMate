// Localized count parsing/formatting. INLINED into content scripts — see
// src/lib/shared/README.md before editing (no imports allowed in this file).

// Localized abbreviated-count multipliers. FB/IG/TikTok render counts abbreviated
// with a locale word or suffix: pt-br "mil"/"mi", en "K"/"M", plus other locales'
// short forms. A missing entry here means a real count parses as null, which is
// how the comment scraper used to lose reaction counts on non-pt/en UIs.
export const COUNT_UNITS = {
  k: 1e3, mil: 1e3, rb: 1e3, tis: 1e3, tys: 1e3, tusen: 1e3,
  m: 1e6, mi: 1e6, mio: 1e6, jt: 1e6, mln: 1e6, mn: 1e6,
  b: 1e9, mrd: 1e9, bi: 1e9,
};

/**
 * Parse a localized count string into a number, or null.
 *   "14 mil" -> 14000   "1,5 mil" -> 1500   "1.2M" -> 1200000   "543" -> 543
 * When a unit word/suffix is present the numeric part is a small decimal, so a
 * comma is the decimal separator (pt-br "1,5"). Without a unit the value is a
 * plain integer whose separators are thousands groups and are stripped.
 */
export function parseCount(text) {
  if (text == null) return null;
  if (typeof text === "number") return Number.isFinite(text) ? text : null;
  // A trailing period is an abbreviation mark in some locales ("1,2 mil.").
  const s = String(text).trim().toLowerCase().replace(/\s+/g, "").replace(/\.$/, "");
  if (!s) return null;
  const m = s.match(/^([\d.,]+)([a-zçã]+)?$/);
  if (!m) return null;
  const rawNum = m[1];
  const unitWord = m[2] || "";
  const mult = unitWord ? COUNT_UNITS[unitWord] : 1;
  if (unitWord && mult == null) return null; // unknown suffix → not a count
  // Separator rules, in order of how much they tell us:
  //   both present   → the LAST one is the decimal, the other is grouping.
  //                    "1.234,5" is 1234.5 (pt-BR) and "1,234.5" is 1234.5 (en).
  //   one + a unit   → that one is the decimal ("76,8 mil", "1.2M").
  //   one, no unit   → grouping; strip it ("1.234" is 1234, "76.800" is 76800).
  const hasDot = rawNum.includes(".");
  const hasComma = rawNum.includes(",");
  let norm;
  if (hasDot && hasComma) {
    const decimal = rawNum.lastIndexOf(".") > rawNum.lastIndexOf(",") ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    norm = rawNum.split(grouping).join("").replace(decimal, ".");
  } else if (unitWord) {
    norm = rawNum.replace(",", ".");
  } else {
    norm = rawNum.replace(/[.,]/g, "");
  }
  const num = parseFloat(norm);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * mult);
}

// Display formatting. 964490 -> "964.5K". Null renders as an em dash rather than
// "0" — an unknown count and a zero count are different facts. Counts are stored
// raw and formatted here at render time.
export function fmtCount(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
