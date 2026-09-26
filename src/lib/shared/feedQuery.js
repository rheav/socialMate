// The feed query: which posts to keep and in what order. Canonical source —
// INLINED into the Instagram bridge and the TikTok relay (see ./README.md: no
// imports allowed here), and imported by the panel, so the side panel's list and
// the site's own grid (reordered in place) always agree.
//
// Shape, as stored in chrome.storage.local (sw_ig_query / sw_tt_query):
//   { version: 1, join: "all" | "any",
//     sorts:   [{ key, dir: "asc" | "desc" }, …],        // first = primary
//     filters: [{ field, op, value, valueTo }, …] }
//
// The engine knows nothing about a platform. A FIELD MAP does
// ({ key: { kind: "number" | "text" | "date" | "enum", get(rec, ctx), values? } }),
// see igQuery.js / ttQuery.js; `ctx` carries whatever a derived field needs (the
// user's ER weights).

export const QUERY_OPS = {
  number: ["gte", "lte", "gt", "lt", "between", "eq", "neq", "notEmpty"],
  date: ["gte", "lte", "between", "notEmpty"],
  text: ["contains", "notContains", "notEmpty"],
  enum: ["isAnyOf"],
};

/**
 * Can this field order a list? Numbers and dates can, unless the field map says
 * `sortable: false` — follower count and duration filter well ("accounts under
 * 10K", "videos under 30 s") but make no sense as an order for a grid of posts.
 */
export function isSortableField(def) {
  return !!def && (def.kind === "number" || def.kind === "date") && def.sortable !== false;
}

export function emptyQuery() {
  return { version: 1, join: "all", sorts: [], filters: [] };
}

const isBlank = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

/** Drop what the field map doesn't know, duplicate sort keys and bad values. */
export function normalizeQuery(q, fields) {
  const out = emptyQuery();
  if (!q || typeof q !== "object") return out;
  out.join = q.join === "any" ? "any" : "all";
  const seen = new Set();
  for (const s of Array.isArray(q.sorts) ? q.sorts : []) {
    if (!s || !fields[s.key] || seen.has(s.key) || (s.dir !== "asc" && s.dir !== "desc")) continue;
    seen.add(s.key);
    out.sorts.push({ key: s.key, dir: s.dir });
  }
  for (const f of Array.isArray(q.filters) ? q.filters : []) {
    const def = f && fields[f.field];
    if (!def || !(QUERY_OPS[def.kind] || []).includes(f.op)) continue;
    out.filters.push({ field: f.field, op: f.op, value: f.value ?? null, valueTo: f.valueTo ?? null });
  }
  return out;
}

function valueOf(rec, key, fields, ctx) {
  const def = fields[key];
  if (!def) return null;
  const v = def.get(rec, ctx || {});
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.length ? v : null;
  return v;
}

/**
 * Does one record pass one rule? A rule still missing its value (mid-typing)
 * passes everything, so the list doesn't blank while the user types.
 */
export function matchesFilter(rec, f, fields, ctx) {
  const def = fields[f.field];
  if (!def) return true;
  const v = valueOf(rec, f.field, fields, ctx);
  if (f.op === "notEmpty") return v != null;
  if (isBlank(f.value) || (f.op === "between" && isBlank(f.valueTo))) return true;
  if (v == null) return false;
  if (def.kind === "text") {
    const hay = (Array.isArray(v) ? v.join(" ") : String(v)).toLowerCase();
    const needle = String(f.value).toLowerCase();
    return f.op === "contains" ? hay.includes(needle) : f.op === "notContains" ? !hay.includes(needle) : true;
  }
  if (def.kind === "enum") {
    const want = (Array.isArray(f.value) ? f.value : [f.value]).map(String);
    return (Array.isArray(v) ? v : [v]).some((x) => want.includes(String(x)));
  }
  const n = Number(v);
  const a = Number(f.value);
  if (!Number.isFinite(n) || !Number.isFinite(a)) return true;
  switch (f.op) {
    case "gt": return n > a;
    case "gte": return n >= a;
    case "lt": return n < a;
    case "lte": return n <= a;
    case "eq": return n === a;
    case "neq": return n !== a;
    case "between": {
      const b = Number(f.valueTo);
      if (!Number.isFinite(b)) return true;
      return n >= Math.min(a, b) && n <= Math.max(a, b);
    }
    default: return true;
  }
}

export function matchesQuery(rec, q, fields, ctx) {
  if (!q.filters.length) return true;
  return q.join === "any"
    ? q.filters.some((f) => matchesFilter(rec, f, fields, ctx))
    : q.filters.every((f) => matchesFilter(rec, f, fields, ctx));
}

/**
 * Comparator for the query's sorts. A missing value sorts last whichever the
 * direction; a full tie returns 0, so Array#sort (stable) keeps capture order.
 */
export function compareByQuery(q, fields, ctx) {
  return (a, b) => {
    for (const s of q.sorts) {
      const av = valueOf(a, s.key, fields, ctx);
      const bv = valueOf(b, s.key, fields, ctx);
      if (av == null && bv == null) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      const d =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      if (d) return s.dir === "asc" ? d : -d;
    }
    return 0;
  };
}

/** Filter, then sort. No sorts = input (capture) order. */
export function applyQuery(records, q, fields, ctx) {
  const kept = records.filter((r) => matchesQuery(r, q, fields, ctx));
  return q.sorts.length ? kept.sort(compareByQuery(q, fields, ctx)) : kept;
}

/** The first sort as the classic select + direction pair ("default" = none). */
export function primarySort(q) {
  const s = q && q.sorts && q.sorts[0];
  return s ? { key: s.key, dir: s.dir } : { key: "default", dir: "desc" };
}

/** Replace the primary sort, keeping the tie-breakers after it. */
export function withPrimarySort(q, key, dir) {
  if (key === "default") return { ...q, sorts: [] };
  const rest = (q.sorts || []).slice(1).filter((s) => s.key !== key);
  return { ...q, sorts: [{ key, dir }, ...rest] };
}

/** Cheap identity for "did the query change?" checks. */
export function querySignature(q) {
  return JSON.stringify([q.join, q.sorts, q.filters]);
}
