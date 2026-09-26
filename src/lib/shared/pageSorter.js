// The site's own grid, sorted and filtered in place — plus the little bar on the
// page that drives it. Canonical source — INLINED into the Instagram bridge and
// the TikTok relay (see ./README.md), after ./feedQuery.js and ./gridSort.js.
//
// ONE query per platform lives in chrome.storage.local (sw_ig_query /
// sw_tt_query). The side panel's sort tool and this bar both read and write it,
// so changing the order in either place reorders the other: the panel list and
// the page grid never disagree.
//
// Everything platform-specific comes in through `opts`:
//   storage       { get(key) → Promise<obj>, set(obj), onChanged(fn(changes)) }
//   storageKey    "sw_ig_query" | "sw_tt_query"
//   fields        IG_QUERY_FIELDS | TT_QUERY_FIELDS
//   ctx()         → { weights } for derived fields (ER)
//   linkSelector  what a tile link looks like
//   keyOf(a)      → the post key a tile link points at
//   recordOf(key) → the captured record, or null
//   linkOk(a)     → false for links outside the grid (hovercards, rails…)
//   routeOk(path) → is this page a grid at all?

import { emptyQuery, normalizeQuery, matchesQuery, compareByQuery, primarySort, withPrimarySort, querySignature, isSortableField } from "./feedQuery.js";
import { gridCellOf, stampOrigIndex, origIndexOf, reorderCells, setCellHidden } from "./gridSort.js";

const PS_BAR_ID = "sw-psort";
const PS_STYLE_ID = "sw-psort-style";
const PS_CSS = `
#${PS_BAR_ID}{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147482500;display:flex;
  align-items:center;gap:6px;padding:6px 8px 6px 10px;border-radius:999px;background:rgba(17,20,32,.92);
  border:1px solid rgba(150,185,255,.35);box-shadow:0 6px 24px rgba(0,0,0,.45);backdrop-filter:blur(8px);
  font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff}
#${PS_BAR_ID} .ps-lbl{opacity:.7;font-weight:600}
#${PS_BAR_ID} select{appearance:none;background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.14);
  border-radius:999px;padding:6px 10px;font:inherit;cursor:pointer;max-width:170px}
#${PS_BAR_ID} select option{color:#111}
#${PS_BAR_ID} button{display:grid;place-items:center;height:26px;min-width:26px;padding:0 8px;border-radius:999px;cursor:pointer;
  background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.14);font:inherit}
#${PS_BAR_ID} button:hover,#${PS_BAR_ID} select:hover{background:rgba(255,255,255,.16)}
#${PS_BAR_ID} .ps-flt{color:#facc15;border-color:rgba(250,204,21,.45)}
#${PS_BAR_ID}[data-min="1"] .ps-full{display:none}
#${PS_BAR_ID}:not([data-min="1"]) .ps-mini{display:none}
`;

export function makePageSorter(opts) {
  const { storage, storageKey, fields, linkSelector, keyOf, recordOf } = opts;
  const ctx = opts.ctx || (() => ({}));
  const linkOk = opts.linkOk || (() => true);
  const routeOk = opts.routeOk || (() => true);
  let query = emptyQuery();
  let timer = null;
  let dead = false;
  let touched = false; // has this page's grid been moved or filtered by us?
  let minimized = false;
  // Every time a grid page opens (load, new tab, SPA hop to another profile or
  // search) the sort starts at the site's own order — a sort picked yesterday must
  // not greet today's page reordered. Filters are kept. A post modal (/p/…) is not
  // a grid route, so opening and closing one does not count as a new page.
  let loaded = false;
  let gridPath = null;

  function collect() {
    const byKey = new Map();
    for (const a of document.querySelectorAll(linkSelector)) {
      if (!linkOk(a)) continue;
      const key = keyOf(a);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, gridCellOf(a, linkSelector, keyOf));
    }
    const entries = [...byKey.entries()].map(([key, cell]) => ({ key, cell }));
    entries.sort((x, y) =>
      x.cell === y.cell ? 0 : x.cell.compareDocumentPosition(y.cell) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    stampOrigIndex(entries.map((e) => e.cell));
    return entries;
  }

  /** One pass: filter (hide), then sort (reorder). Returns cells moved. */
  function applyNow() {
    timer = null;
    if (dead) return 0;
    const onRoute = routeOk(location.pathname);
    if (loaded && onRoute && location.pathname !== gridPath) {
      gridPath = location.pathname;
      if (query.sorts.length) {
        query = { ...query, sorts: [] };
        storage.set({ [storageKey]: query });
        renderBarState();
      }
    }
    const entries = onRoute ? collect() : [];
    renderBar(onRoute && entries.length >= 2);
    if (!entries.length) return 0;
    const active = query.sorts.length > 0 || query.filters.length > 0;
    if (!active && !touched) return 0;
    const c = ctx();
    for (const e of entries) {
      const rec = recordOf(e.key);
      // A tile with no captured record stays visible: "not known yet" is not "rejected".
      setCellHidden(e.cell, !!(rec && query.filters.length && !matchesQuery(rec, query, fields, c)));
    }
    let ordered;
    if (!query.sorts.length) {
      ordered = entries.map((e) => e.cell).sort((x, y) => origIndexOf(x) - origIndexOf(y));
    } else {
      const cmp = compareByQuery(query, fields, c);
      ordered = [...entries]
        .sort((x, y) => {
          const rx = recordOf(x.key);
          const ry = recordOf(y.key);
          if (rx && ry) return cmp(rx, ry) || origIndexOf(x.cell) - origIndexOf(y.cell);
          if (rx) return -1;
          if (ry) return 1;
          return origIndexOf(x.cell) - origIndexOf(y.cell);
        })
        .map((e) => e.cell);
    }
    const moved = reorderCells(entries.map((e) => e.cell), ordered);
    touched = active;
    return moved;
  }

  // A pending pass is NOT pushed back by later calls (the page mutates without
  // pause — a resetting debounce would never fire); only an immediate request
  // (ms = 0: the query changed) jumps the queue.
  function schedule(ms = 250) {
    if (dead) return;
    if (timer) {
      if (ms > 0) return;
      clearTimeout(timer);
    }
    timer = setTimeout(applyNow, ms);
  }

  function setQuery(q) {
    query = normalizeQuery(q, fields);
    storage.set({ [storageKey]: query });
    renderBarState();
    schedule(0);
  }

  // ---- the bar ----
  function sortableKeys() {
    return Object.keys(fields).filter((k) => isSortableField(fields[k]));
  }
  function ensureBar() {
    let bar = document.getElementById(PS_BAR_ID);
    if (bar) return bar;
    if (!document.getElementById(PS_STYLE_ID)) {
      const st = document.createElement("style");
      st.id = PS_STYLE_ID;
      st.textContent = PS_CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    bar = document.createElement("div");
    bar.id = PS_BAR_ID;
    const opt = (v, l) => `<option value="${v}">${l}</option>`;
    bar.innerHTML =
      `<button type="button" class="ps-mini" data-ps="expand" title="Ordenar a grade">⇅</button>` +
      `<span class="ps-full ps-lbl">Ordenar</span>` +
      `<select class="ps-full" data-ps="key" title="Ordenar a grade por">${opt("default", "Padrão do site")}${sortableKeys()
        .map((k) => opt(k, fields[k].label))
        .join("")}</select>` +
      `<button type="button" class="ps-full" data-ps="dir"></button>` +
      `<button type="button" class="ps-full ps-flt" data-ps="flt" title="Filtros ativos — edite no painel"></button>` +
      `<button type="button" class="ps-full" data-ps="min" title="Recolher">–</button>`;
    for (const ev of ["pointerdown", "mousedown", "click", "keydown", "wheel"])
      bar.addEventListener(ev, (e) => e.stopPropagation());
    bar.querySelector('[data-ps="key"]').addEventListener("change", (e) => {
      setQuery(withPrimarySort(query, e.target.value, primarySort(query).dir));
    });
    bar.querySelector('[data-ps="dir"]').addEventListener("click", () => {
      const p = primarySort(query);
      if (p.key === "default") return;
      setQuery(withPrimarySort(query, p.key, p.dir === "desc" ? "asc" : "desc"));
    });
    bar.querySelector('[data-ps="flt"]').addEventListener("click", () => setQuery({ ...query, filters: [] }));
    bar.querySelector('[data-ps="min"]').addEventListener("click", () => { minimized = true; renderBarState(); });
    bar.querySelector('[data-ps="expand"]').addEventListener("click", () => { minimized = false; renderBarState(); });
    (document.body || document.documentElement).appendChild(bar);
    return bar;
  }
  function renderBarState() {
    const bar = document.getElementById(PS_BAR_ID);
    if (!bar) return;
    const p = primarySort(query);
    bar.dataset.min = minimized ? "1" : "";
    const sel = bar.querySelector('[data-ps="key"]');
    if (sel.value !== p.key) sel.value = p.key;
    const dir = bar.querySelector('[data-ps="dir"]');
    dir.textContent = p.dir === "desc" ? "↓" : "↑";
    dir.title = p.dir === "desc" ? "Maior → menor" : "Menor → maior";
    dir.style.display = minimized || p.key === "default" ? "none" : "";
    const flt = bar.querySelector('[data-ps="flt"]');
    const n = query.filters.length;
    flt.textContent = n ? `${n} filtro${n > 1 ? "s" : ""} ✕` : "";
    flt.style.display = minimized || !n ? "none" : "";
  }
  function renderBar(show) {
    const bar = document.getElementById(PS_BAR_ID);
    if (!show || opts.barEnabled === false || (opts.barVisible && !opts.barVisible())) {
      if (bar) bar.remove();
      return;
    }
    ensureBar();
    renderBarState();
  }

  storage.get(storageKey).then((r) => {
    query = normalizeQuery(r && r[storageKey], fields);
    loaded = true;
    renderBarState();
    schedule(0);
  });
  storage.onChanged((changes) => {
    if (!changes[storageKey]) return;
    const next = normalizeQuery(changes[storageKey].newValue, fields);
    if (querySignature(next) === querySignature(query)) return;
    query = next;
    renderBarState();
    schedule(0);
  });

  return {
    schedule,
    applyNow,
    getQuery: () => query,
    destroy() {
      dead = true;
      if (timer) clearTimeout(timer);
      document.getElementById(PS_BAR_ID)?.remove();
    },
  };
}

/** The chrome.storage.local adapter the content scripts hand to makePageSorter. */
export function chromeQueryStorage() {
  return {
    get: (k) => chrome.storage.local.get(k).catch(() => ({})),
    set: (obj) => { chrome.storage.local.set(obj).catch(() => {}); },
    onChanged: (fn) =>
      chrome.storage.onChanged.addListener((changes, area) => { if (area === "local") fn(changes); }),
  };
}
