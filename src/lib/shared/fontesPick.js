// "Fontes" button (ugc-factory's "Fontes de look"): which address of an <img> is the
// photo itself, and which network it came from. Inlined into
// src/content/fontes/fontes-button.js — import-free, see this dir's README.

/** Smaller than this on either side is an avatar or an icon, not a photo. */
export const FONTES_MIN_SIDE = 160;

/**
 * The best candidate of an image: the widest `w` entry of its srcset (the
 * largest `x` one when there are no widths), else its own src. Never a blob: or
 * data: address, which the worker cannot fetch.
 */
export function fontesBestUrl(srcset, src) {
  let best = null;
  let bestW = -1;
  let bestX = -1;
  let bestByX = null;
  // Entries are "url descriptor"; commas also live inside urls, so split before the next http.
  for (const part of String(srcset || "").split(/,\s*(?=https?:)/i)) {
    const m = part.trim().match(/^(\S+)\s+(\d+(?:\.\d+)?)([wx])$/i);
    if (!m) continue;
    const n = Number(m[2]);
    if (m[3].toLowerCase() === "w" && n > bestW) { best = m[1]; bestW = n; }
    if (m[3].toLowerCase() === "x" && n > bestX) { bestByX = m[1]; bestX = n; }
  }
  const pick = best || bestByX || src || null;
  return pick && /^https?:\/\//i.test(pick) ? pick : null;
}

/** The network a page belongs to, as ugc-factory files it; null elsewhere. */
export function fontesOrigin(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (/(^|\.)instagram\.com$/.test(h)) return "instagram";
  if (/(^|\.)tiktok\.com$/.test(h)) return "tiktok";
  return null;
}
