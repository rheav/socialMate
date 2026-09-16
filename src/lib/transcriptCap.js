// How many transcriptions the Arquivo keeps.
//
// The store is ONE object in chrome.storage.local, re-serialized on every write
// and re-read by every panel and page overlay that watches it — and each record
// carries its thumbnail as a `data:` WebP (6–16KB measured). So the cap is not a
// licence limit, it is the thing that keeps a write from costing megabytes.
//
// 20 was hard-coded. It is now a choice, because the ceiling that matters is the
// user's: someone reviewing a niche wants a hundred of them, and the cost of
// that is theirs to accept. Unlimited is offered too — with the warning it
// deserves rather than a quiet cliff.

export const TRANSCRIPT_CAP_KEY = "fbw_transcript_cap";
export const DEFAULT_TRANSCRIPT_CAP = 20;
/** 0 means "keep everything". */
export const UNLIMITED = 0;
const MAX_CAP = 2000;

export const TRANSCRIPT_CAP_OPTIONS = [
  { value: 20, label: "20", hint: "padrão" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 300, label: "300" },
  { value: UNLIMITED, label: "sem limite", hint: "o painel relê o acervo inteiro a cada escrita" },
];

/**
 * A stored value turned into a cap. Anything unparseable falls back to the
 * default rather than to "unlimited": a corrupt key must not silently remove the
 * ceiling that protects every write.
 */
export function normalizeTranscriptCap(value) {
  if (value === UNLIMITED || value === "0") return UNLIMITED;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TRANSCRIPT_CAP;
  return Math.min(Math.floor(n), MAX_CAP);
}

/** Which ids to drop, newest kept. Empty when the store is within its cap. */
export function idsOverCap(records, cap) {
  const limit = normalizeTranscriptCap(cap);
  if (limit === UNLIMITED) return [];
  const ids = Object.keys(records || {});
  if (ids.length <= limit) return [];
  return ids
    .sort((a, b) => (records[b]?.updatedAt || 0) - (records[a]?.updatedAt || 0))
    .slice(limit);
}

export async function readTranscriptCap() {
  if (typeof chrome === "undefined" || !chrome?.storage?.local) return DEFAULT_TRANSCRIPT_CAP;
  const r = await chrome.storage.local.get(TRANSCRIPT_CAP_KEY);
  return normalizeTranscriptCap(r[TRANSCRIPT_CAP_KEY]);
}

export function writeTranscriptCap(value) {
  return chrome.storage.local.set({ [TRANSCRIPT_CAP_KEY]: normalizeTranscriptCap(value) });
}
