# Swiss-knife Shell + Instagram Sort/Download — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe socialWarmer's UI as a launcher shell (Home → platform hub → tool) with a declarative tool registry, and land the Instagram Sort/Download tool inside it as the proof slice.

**Architecture:** Incremental refactor of the UI layer only. A new `Shell` owns a `{screen, platform, tool}` nav state machine and renders tools from a declarative registry (`lib/tools.jsx`). The 810-line `App.jsx` is decomposed into per-tool panels. The warming engine (`content.js`), media pipeline (`offscreen/*`, `lib/fbcdn.js`), and FB capture are untouched; `content/ig/*` and `background.js` get additive changes only. IG Sort reads the existing passive JSON.parse capture into a panel card list and downloads video/image/carousel via a new background message.

**Tech Stack:** React 19, Vite 8, Tailwind v4, CRXJS 2.4, lucide-react, shadcn-style UI, `chrome.storage.local`, Chrome MV3 (side panel, content scripts MAIN+isolated world, background service worker, `chrome.downloads`). Vitest (new) for pure-helper unit tests.

## Global Constraints

- Manifest V3; no new permissions (existing: storage, activeTab, sidePanel, tabs, webRequest, offscreen, downloads; hosts include `*.instagram.com`, `*.cdninstagram.com`).
- No TypeScript — JSX only.
- Do NOT modify `src/content.js`, `src/offscreen/*`, `src/lib/fbcdn.js`, `src/content/transcription/*`.
- `content/ig/main-world.js` runs in the page MAIN world as a plain IIFE — it **cannot import** from `src/lib` (not a module context). Keep its helpers inline.
- Message-type names keep the `FBW_*` prefix (panel/content/background compatibility).
- Build to verify: `npm run build` (emits `dist/`), load unpacked `dist/` at `chrome://extensions`.
- Icons come from `lucide-react` (already a dep).
- Keep per-card copy terse; reuse existing shadcn components in `src/components/ui/*`.

---

## File Structure

**New files:**
- `src/lib/igMedia.js` — pure helpers: sort comparator, record→card, filename, ext. (unit-tested)
- `src/lib/tabs.js` — `resolvePlatformTab`, `PLATFORM_HOST`, `matchesPlatform` (extracted from App.jsx so multiple tools share them).
- `src/lib/tools.jsx` — declarative tool registry + selectors.
- `src/components/Shell.jsx` — launcher nav state machine + theme retint + header chrome.
- `src/components/ui/Launcher.jsx` — grid of platform cards / tool cards.
- `src/components/ui/ToolFrame.jsx` — back button + title + platform-swap wrapper around a tool Panel.
- `src/components/tools/WarmTool.jsx` — the warm form + status + log (moved out of App.jsx).
- `src/components/tools/LibraryTool.jsx` — inner tabs wrapping existing Transcripts/Saved/History.
- `src/components/tools/IgSortTool.jsx` — the IG Sort/Download panel.
- `src/lib/igMedia.test.js`, `src/lib/tools.test.js` — Vitest unit tests.
- `vitest.config.js` — test config.

**Modified files:**
- `src/content/ig/main-world.js` — extend `lite()` (media_type, image, carousel, taken_at).
- `src/content/ig/bridge.js` — surface stamping + `FBW_IG_LIST` responder + deduped record list.
- `src/background.js` — add `FBW_DL_MEDIA` handler (video direct / image base64 / carousel per-child).
- `src/App.jsx` — shrink to mount `<Shell/>` (History inline component moves to LibraryTool).
- `package.json` — add `vitest` dev dep + `test` script.

---

## Task 1: Pure IG helpers (`lib/igMedia.js`) — TDD

**Files:**
- Create: `src/lib/igMedia.js`
- Create: `src/lib/igMedia.test.js`
- Create: `vitest.config.js`
- Modify: `package.json` (devDeps + scripts)

**Interfaces:**
- Produces:
  - `sortComparator(key: 'likes'|'views'|'comments'|'date', dir: 'desc'|'asc') => (a,b)=>number` — nulls always sort last.
  - `sortRecords(records: object[], key, dir) => object[]` (non-mutating).
  - `recordToCard(rec) => { id, username, thumb, type:'photo'|'video'|'carousel', likes, comments, views, hasVideo, permalink }`.
  - `sanitizeFilenamePart(s) => string`, `filenameFor(rec, ext, idx?) => string`, `extFromUrl(url, kind:'video'|'image') => string`.

- [ ] **Step 1: Add vitest dev dependency + script**

Run:
```bash
npm i -D vitest
```
Then modify `package.json` scripts to add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Create `vitest.config.js`**

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.js"] },
  resolve: { alias: { "@": "/src" } },
});
```

- [ ] **Step 3: Write the failing tests** — `src/lib/igMedia.test.js`

```js
import { describe, it, expect } from "vitest";
import {
  sortComparator, sortRecords, recordToCard,
  sanitizeFilenamePart, filenameFor, extFromUrl,
} from "./igMedia.js";

const recs = [
  { code: "A", username: "a", like_count: 10, comment_count: 3, play_count: 100, taken_at: 5, media_type: "video", video: "v" },
  { code: "B", username: "b", like_count: 50, comment_count: 1, play_count: null, taken_at: 9, media_type: "photo", image: "i" },
  { code: "C", username: "c", like_count: 30, comment_count: 9, play_count: 200, taken_at: 1, media_type: "video", video: "v" },
];

describe("sortComparator", () => {
  it("sorts by likes desc", () => {
    expect(sortRecords(recs, "likes", "desc").map(r => r.code)).toEqual(["B", "C", "A"]);
  });
  it("sorts by likes asc", () => {
    expect(sortRecords(recs, "likes", "asc").map(r => r.code)).toEqual(["A", "C", "B"]);
  });
  it("puts null metric last regardless of dir (views)", () => {
    expect(sortRecords(recs, "views", "desc").map(r => r.code)).toEqual(["C", "A", "B"]);
    expect(sortRecords(recs, "views", "asc").map(r => r.code)).toEqual(["A", "C", "B"]);
  });
  it("sorts by date desc", () => {
    expect(sortRecords(recs, "date", "desc").map(r => r.code)).toEqual(["B", "A", "C"]);
  });
  it("does not mutate input", () => {
    const before = recs.map(r => r.code);
    sortRecords(recs, "likes", "desc");
    expect(recs.map(r => r.code)).toEqual(before);
  });
});

describe("recordToCard", () => {
  it("maps a video record", () => {
    const c = recordToCard(recs[0]);
    expect(c).toMatchObject({ id: "A", username: "a", type: "video", hasVideo: true, likes: 10 });
    expect(c.permalink).toBe("https://www.instagram.com/p/A/");
  });
  it("falls back id to pk and username to unknown", () => {
    expect(recordToCard({ pk: "9", media_type: "photo" })).toMatchObject({ id: "9", username: "unknown", hasVideo: false });
  });
});

describe("filenames", () => {
  it("sanitizes unsafe chars", () => {
    expect(sanitizeFilenamePart('a/b:c*?"<>|d')).toBe("a_b_c_d");
  });
  it("builds base and indexed names", () => {
    expect(filenameFor({ username: "ivy", code: "X1" }, "mp4")).toBe("ig-ivy-X1.mp4");
    expect(filenameFor({ username: "ivy", code: "X1" }, "jpg", 2)).toBe("ig-ivy-X1_2.jpg");
  });
  it("derives extension", () => {
    expect(extFromUrl("https://x/y.mp4?a=1", "video")).toBe("mp4");
    expect(extFromUrl("https://x/y.webp", "image")).toBe("webp");
    expect(extFromUrl("https://x/y", "image")).toBe("jpg");
    expect(extFromUrl("https://x/y", "video")).toBe("mp4");
  });
});
```

- [ ] **Step 4: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL — `igMedia.js` has no exports / cannot resolve module.

- [ ] **Step 5: Implement `src/lib/igMedia.js`**

```js
// Pure, DOM-free helpers for the IG Sort tool (panel side). Unit-tested.

const KEY_FIELD = {
  likes: "like_count",
  views: "play_count",
  comments: "comment_count",
  date: "taken_at",
};

// Comparator over IG records. Missing metrics (e.g. photos have no play_count)
// always sort last, whatever the direction.
export function sortComparator(key, dir = "desc") {
  const field = KEY_FIELD[key] || "like_count";
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const av = a[field], bv = b[field];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * sign;
  };
}

export function sortRecords(records, key, dir) {
  return [...records].sort(sortComparator(key, dir));
}

export function recordToCard(rec) {
  const type = rec.media_type || (rec.video ? "video" : "photo");
  const code = rec.code || null;
  return {
    id: code || rec.pk || "",
    username: rec.username || rec.full_name || "unknown",
    thumb: rec.thumb || rec.image || null,
    type,
    likes: rec.like_count ?? null,
    comments: rec.comment_count ?? null,
    views: rec.play_count ?? null,
    hasVideo: !!rec.video || type === "video",
    permalink: code ? `https://www.instagram.com/p/${code}/` : null,
  };
}

export function sanitizeFilenamePart(s) {
  return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

export function filenameFor(rec, ext, idx) {
  const base = `ig-${sanitizeFilenamePart(rec.username)}-${rec.code || rec.pk || Date.now()}`;
  return idx != null ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}

export function extFromUrl(url, kind) {
  const m = String(url || "").match(/\.(mp4|mov|webm|jpg|jpeg|png|webp|gif)(\?|$)/i);
  if (m) { const e = m[1].toLowerCase(); return e === "jpeg" ? "jpg" : e; }
  return kind === "video" ? "mp4" : "jpg";
}
```

- [ ] **Step 6: Run tests, verify pass**

Run: `npm test`
Expected: PASS (all `igMedia` tests green).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.js src/lib/igMedia.js src/lib/igMedia.test.js
git commit -m "feat: pure IG media helpers + vitest harness"
```

---

## Task 2: Shared tab helpers + tool registry — TDD (selector)

**Files:**
- Create: `src/lib/tabs.js`
- Create: `src/lib/tools.jsx`
- Create: `src/lib/tools.test.js`

**Interfaces:**
- `tabs.js` produces: `PLATFORM_HOST`, `matchesPlatform(platform, url)`, `hasChromeTabs()`, `resolvePlatformTab(platform) => Promise<number|null>` (moved verbatim from `App.jsx:37-61`).
- `tools.jsx` produces: `TOOLS` (array of `{id,label,Icon,platforms,Panel,requiresTab}`), `filterToolsForPlatform(tools, platform) => tool[]` (pure), `toolsForPlatform(platform)`, `globalTools()`, `getTool(id)`.

- [ ] **Step 1: Create `src/lib/tabs.js`** (move from App.jsx, unchanged logic)

```js
// Resolve which browser tab a platform tool should drive. Extracted from App.jsx
// so Warm and IG-Sort (and future tools) share one implementation.
export const PLATFORM_HOST = {
  facebook: { re: /(^|\.)facebook\.com$/, glob: ["*://*.facebook.com/*"] },
  instagram: { re: /(^|\.)instagram\.com$/, glob: ["*://*.instagram.com/*"] },
  tiktok: { re: /(^|\.)tiktok\.com$/, glob: ["*://*.tiktok.com/*"] },
};

export const matchesPlatform = (platform, url) => {
  try { return PLATFORM_HOST[platform].re.test(new URL(url).hostname); }
  catch { return false; }
};

export const hasChromeTabs = () => typeof chrome !== "undefined" && !!chrome?.tabs?.query;

export async function resolvePlatformTab(platform) {
  if (!hasChromeTabs()) return null;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && matchesPlatform(platform, active.url || "")) return active.id;
  const tabs = await chrome.tabs.query({ url: PLATFORM_HOST[platform].glob });
  return tabs.length ? tabs[0].id : null;
}
```

- [ ] **Step 2: Write the failing test** — `src/lib/tools.test.js`

```js
import { describe, it, expect } from "vitest";
import { filterToolsForPlatform } from "./tools.jsx";

const fixture = [
  { id: "warm", platforms: ["facebook", "instagram", "tiktok"] },
  { id: "ig-sort", platforms: ["instagram"] },
  { id: "download", platforms: ["facebook"] },
  { id: "library", platforms: "global" },
];

describe("filterToolsForPlatform", () => {
  it("returns platform tools, excludes global", () => {
    expect(filterToolsForPlatform(fixture, "instagram").map(t => t.id)).toEqual(["warm", "ig-sort"]);
    expect(filterToolsForPlatform(fixture, "facebook").map(t => t.id)).toEqual(["warm", "download"]);
    expect(filterToolsForPlatform(fixture, "tiktok").map(t => t.id)).toEqual(["warm"]);
  });
});
```

- [ ] **Step 3: Run test, verify fail**

Run: `npm test src/lib/tools.test.js`
Expected: FAIL — cannot resolve `./tools.jsx` / no export.

- [ ] **Step 4: Implement `src/lib/tools.jsx`**

```jsx
import { Flame, ArrowDownUp, Download, Library as LibraryIcon } from "lucide-react";
import WarmTool from "@/components/tools/WarmTool";
import IgSortTool from "@/components/tools/IgSortTool";
import LibraryTool from "@/components/tools/LibraryTool";
import DownloadPanel from "@/components/DownloadPanel";

// Declarative registry — the single source of truth for what tool shows where.
// Adding a platform/tool later is an entry here + its Panel; the Shell never changes.
export const TOOLS = [
  { id: "warm", label: "Warm", Icon: Flame, platforms: ["facebook", "instagram", "tiktok"], Panel: WarmTool, requiresTab: true },
  { id: "ig-sort", label: "Sort + Download", Icon: ArrowDownUp, platforms: ["instagram"], Panel: IgSortTool, requiresTab: true },
  { id: "download", label: "Download", Icon: Download, platforms: ["facebook"], Panel: DownloadPanel, requiresTab: true },
  { id: "library", label: "Library", Icon: LibraryIcon, platforms: "global", Panel: LibraryTool, requiresTab: false },
];

// Pure (testable): given any tool array + platform, the platform's non-global tools.
export const filterToolsForPlatform = (tools, platform) =>
  tools.filter((t) => t.platforms !== "global" && t.platforms.includes(platform));

export const toolsForPlatform = (platform) => filterToolsForPlatform(TOOLS, platform);
export const globalTools = () => TOOLS.filter((t) => t.platforms === "global");
export const getTool = (id) => TOOLS.find((t) => t.id === id) || null;
```

> NOTE: This imports `WarmTool`, `IgSortTool`, `LibraryTool`, which are created in Tasks 4–6 and 8. Until those exist the module won't build. Order of execution: create empty stub components first is unnecessary — Tasks 3–8 land before the Shell wires them (Task 7). To keep `npm test` green now, the test imports only `filterToolsForPlatform`; vitest tree-shakes unused imports at module eval only if the imported components resolve. If the test fails to resolve component imports, create one-line placeholder default-export stubs for the three tool components now and flesh them out in their tasks.

- [ ] **Step 5: Run test, verify pass**

Run: `npm test src/lib/tools.test.js`
Expected: PASS. (If it fails on unresolved component imports, add stub files: `export default function X(){return null}` for WarmTool/IgSortTool/LibraryTool, then re-run.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/tabs.js src/lib/tools.jsx src/lib/tools.test.js
git commit -m "feat: shared tab helpers + declarative tool registry"
```

---

## Task 3: Extract `WarmTool` from `App.jsx`

**Files:**
- Create: `src/components/tools/WarmTool.jsx`
- Modify: `src/App.jsx` (remove the warm form/status/log; keep History for Task 4)

**Interfaces:**
- Consumes: `resolvePlatformTab` from `lib/tabs.js`; `PLATFORMS` from `lib/platforms.jsx`.
- Produces: `export default function WarmTool({ platform })` — self-contained; owns its `tabId`, polling, options persistence, start/pause/stop, detach, and the warm form + status + log. No `view`/`BottomNav`/`PlatformSwitcher` (those belong to the Shell).

- [ ] **Step 1: Create `WarmTool.jsx` by moving warm logic verbatim**

Move — do NOT rewrite — from `App.jsx` into `WarmTool.jsx`:
  - all warm state (`mode, keyword, targetN, personality, actions, englishOnly, relevanceMin, spamGuard, deepRelevance, pacing, sessionCap, thresholds, autoCapture, status, noTab, tabId, logRef`),
  - the options-persistence effects, `send`, `poll`, tab-binding effects, `start/togglePause/stop/detach/toggle`, `hint`,
  - the JSX from the warm branch (mode Segmented, keyword input, target/personality, actions Card, relevance Card, status/counters/log, Start/Pause/Stop/detach buttons),
  - the helper components `StatusChip`, `Stat`, `Counter`, `Logo` used by the warm UI.

Replace the internal `platform` state with the `platform` **prop**. Import `resolvePlatformTab` from `@/lib/tabs`. Import `PLATFORMS` from `@/lib/platforms`. `const platformCfg = PLATFORMS[platform]; const modeTabs = platformCfg.modes;`. Initialize `mode` from `platformCfg.defaultMode`. Drop the platform-switch handler and the retint effect (Shell owns retint). Keep the `OptionsDropdown` in the tool header row (or lift to Shell later — keep here for now).

- [ ] **Step 2: Trim `App.jsx`**

Remove everything moved. Temporarily render `<WarmTool platform="facebook" />` from `App.jsx` so the app still builds and the warmer is verifiable before the Shell lands. Keep the `HistoryPanel` function in `App.jsx` for now (Task 4 relocates it).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build succeeds, no unresolved imports.

- [ ] **Step 4: Manual verification (no unit test — extension-runtime UI)**

Load `dist/` unpacked. Open the side panel on a Facebook tab. Confirm: warm form renders, Start begins a run (log ticks, counters move), Pause/Stop/detach behave as before. This proves the extraction didn't regress the engine.

- [ ] **Step 5: Commit**

```bash
git add src/components/tools/WarmTool.jsx src/App.jsx
git commit -m "refactor: extract WarmTool from App.jsx (behavior unchanged)"
```

---

## Task 4: `LibraryTool` (Saved + Transcripts + History inner tabs)

**Files:**
- Create: `src/components/tools/LibraryTool.jsx`
- Modify: `src/App.jsx` (move `HistoryPanel` out)
- Reference (unchanged): `src/components/TranscriptsPanel.jsx` (exports `TranscriptsPanel` + `SavedPanel`)

**Interfaces:**
- Produces: `export default function LibraryTool()` — a `TabNav` (existing `src/components/ui/TabNav.jsx`) switching between Saved / Transcripts / History sub-panels. No platform prop (global tool).

- [ ] **Step 1: Move `HistoryPanel`** from `App.jsx` into `LibraryTool.jsx` (verbatim function), and import `TranscriptsPanel, { SavedPanel }` and the `Card`/`Button` deps it uses.

- [ ] **Step 2: Implement `LibraryTool.jsx`**

```jsx
import { useState } from "react";
import TabNav from "@/components/ui/TabNav";
import TranscriptsPanel, { SavedPanel } from "@/components/TranscriptsPanel";
// HistoryPanel moved here from App.jsx (paste the function body verbatim)
// ...HistoryPanel definition...

export default function LibraryTool() {
  const [tab, setTab] = useState("saved");
  return (
    <div className="space-y-3">
      <TabNav
        value={tab}
        onChange={setTab}
        items={[
          { id: "saved", label: "Saved" },
          { id: "transcripts", label: "Transcripts" },
          { id: "history", label: "History" },
        ]}
      />
      {tab === "saved" ? <SavedPanel /> : tab === "transcripts" ? <TranscriptsPanel /> : <HistoryPanel />}
    </div>
  );
}
```

> Verify `TabNav`'s prop names against `src/components/ui/TabNav.jsx` before wiring; adapt `value/onChange/items` to its actual signature (it is already used for BottomNav-style nav in the codebase).

- [ ] **Step 3: Build + verify**

Run: `npm run build` → succeeds. Load `dist/`, temporarily render `<LibraryTool/>` from App.jsx, confirm all three sub-tabs render (Saved list, Transcripts list, History list) with existing data.

- [ ] **Step 4: Commit**

```bash
git add src/components/tools/LibraryTool.jsx src/App.jsx
git commit -m "refactor: LibraryTool wraps Saved/Transcripts/History"
```

---

## Task 5: `IgSortTool` panel

**Files:**
- Create: `src/components/tools/IgSortTool.jsx`
- Uses: `lib/igMedia.js` (Task 1), `lib/tabs.js` (Task 2)

> This task builds the UI against the **existing** in-view capture first, then Task 6 adds `FBW_IG_LIST` for the full list and Task 7 adds real downloads. To make the tool independently demoable now, it degrades gracefully: if `FBW_IG_LIST` isn't handled yet, it shows the empty state.

**Interfaces:**
- Consumes: `sortRecords, recordToCard, filenameFor, extFromUrl` from `@/lib/igMedia`; `resolvePlatformTab` from `@/lib/tabs`.
- Produces: `export default function IgSortTool({ platform })`.
- Sends: `FBW_IG_LIST` (to the IG tab, expects `{records, surface}`), `FBW_DL_MEDIA` (to background, expects `{ok,error?}`).

- [ ] **Step 1: Implement `IgSortTool.jsx`**

```jsx
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownUp, Download, Bookmark, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { resolvePlatformTab } from "@/lib/tabs";
import { sortRecords, recordToCard, filenameFor, extFromUrl } from "@/lib/igMedia";

const SORT_LABEL = { likes: "Likes", views: "Views", comments: "Comments", date: "Date" };

export default function IgSortTool() {
  const [records, setRecords] = useState([]);
  const [surface, setSurface] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [sortKey, setSortKey] = useState("likes");
  const [sortDir, setSortDir] = useState("desc");
  const [noTab, setNoTab] = useState(false);
  const [busy, setBusy] = useState({}); // id -> 'downloading'|'done'|'error'
  const tabId = useRef(null);

  const listFromTab = useCallback(async () => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("instagram");
    if (tabId.current == null) { setNoTab(true); return; }
    setNoTab(false);
    try {
      const res = await chrome.tabs.sendMessage(tabId.current, { type: "FBW_IG_LIST" });
      if (res && Array.isArray(res.records)) { setRecords(res.records); setSurface(res.surface || null); }
    } catch { tabId.current = null; }
  }, []);

  useEffect(() => {
    listFromTab();
    const id = setInterval(listFromTab, 2000);
    return () => clearInterval(id);
  }, [listFromTab]);

  const scoped = showAll ? records : records.filter((r) => !surface || r.surface === surface);
  const sorted = sortRecords(scoped, sortKey, sortDir);

  const bg = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));

  async function downloadRecord(rec) {
    const card = recordToCard(rec);
    setBusy((b) => ({ ...b, [card.id]: "downloading" }));
    try {
      if (rec.media_type === "carousel" && Array.isArray(rec.carousel)) {
        let i = 0;
        for (const child of rec.carousel) {
          i += 1;
          const isVid = child.media_type === "video" && child.video;
          const url = isVid ? child.video : child.image;
          if (!url) continue;
          await bg({ type: "FBW_DL_MEDIA", kind: isVid ? "video" : "image",
            url, filename: filenameFor(rec, extFromUrl(url, isVid ? "video" : "image"), i) });
        }
      } else if (rec.video) {
        await bg({ type: "FBW_DL_MEDIA", kind: "video", url: rec.video,
          filename: filenameFor(rec, extFromUrl(rec.video, "video")) });
      } else if (rec.image) {
        await bg({ type: "FBW_DL_MEDIA", kind: "image", url: rec.image,
          filename: filenameFor(rec, extFromUrl(rec.image, "image")) });
      }
      setBusy((b) => ({ ...b, [card.id]: "done" }));
    } catch { setBusy((b) => ({ ...b, [card.id]: "error" })); }
  }

  async function downloadAll() {
    for (const rec of sorted) { await downloadRecord(rec); await new Promise((r) => setTimeout(r, 400)); }
  }

  async function saveToLibrary(rec) {
    try {
      const r = await chrome.storage.local.get("fbw_saved");
      const map = r.fbw_saved || {};
      const id = rec.code || rec.pk;
      map[id] = { ...(map[id] || {}), ...rec, videoId: id, platform: "instagram", autoSaved: false, updatedAt: Date.now() };
      await chrome.storage.local.set({ fbw_saved: map });
    } catch {}
  }

  if (noTab)
    return <div className="rounded-md bg-amber-500/10 text-amber-700 text-xs px-3 py-2">Open Instagram in a tab, then reopen this panel.</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={sortKey} onValueChange={setSortKey}>
          <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(SORT_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          title={sortDir === "desc" ? "High → low" : "Low → high"}>
          {sortDir === "desc" ? <ArrowDown /> : <ArrowUp />}
        </Button>
        <Button variant="secondary" onClick={downloadAll} disabled={!sorted.length}>
          <Download /> All
        </Button>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{sorted.length} collected{surface ? ` · ${surface}` : ""}</span>
        <button className="underline" onClick={() => setShowAll((v) => !v)}>{showAll ? "scope to surface" : "show all"}</button>
      </div>

      {!sorted.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Scroll the Instagram feed to collect posts, then sort here.</p>
      ) : (
        <div className="space-y-2">
          {sorted.map((rec) => {
            const c = recordToCard(rec);
            return (
              <Card key={c.id}>
                <CardContent className="p-2.5 flex items-center gap-2.5">
                  <div className="w-9 h-11 rounded-md bg-muted bg-cover bg-center flex-none"
                    style={c.thumb ? { backgroundImage: `url(${c.thumb})` } : undefined} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">@{c.username}</div>
                    <div className="text-[10px] text-muted-foreground">
                      ❤ {c.likes ?? "—"} · 💬 {c.comments ?? "—"} {c.views != null ? `· ▶ ${c.views}` : ""} · {c.type}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => saveToLibrary(rec)} title="Save to Library"><Bookmark /></Button>
                  <Button variant="ghost" size="icon" onClick={() => downloadRecord(rec)}
                    title="Download" disabled={busy[c.id] === "downloading"}><Download /></Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/tools/IgSortTool.jsx
git commit -m "feat: IgSortTool panel (sort + per-card/bulk download UI)"
```

---

## Task 6: IG capture — `lite()` extension + `FBW_IG_LIST` + surface stamp

**Files:**
- Modify: `src/content/ig/main-world.js` (`lite()`)
- Modify: `src/content/ig/bridge.js` (record list, surface, responder)

**Interfaces:**
- `main-world.js` `lite(m)` gains fields: `media_type:'photo'|'video'|'carousel'`, `image:string|null`, `carousel: {media_type,image,video}[]|null`, `taken_at:number|null`.
- `bridge.js` answers `chrome.runtime.onMessage` `FBW_IG_LIST` → `{ records: object[], surface: string }`; each record carries `surface`.

- [ ] **Step 1: Extend `lite()` in `main-world.js`**

Add these helpers inside the IIFE (above `lite`), inline (MAIN world can't import):

```js
function mediaTypeName(m) {
  if (m.media_type === 8 || m.carousel_media) return "carousel";
  if (m.media_type === 2 || m.video_versions) return "video";
  return "photo";
}
function bestImage(m) {
  const c = m.image_versions2 && m.image_versions2.candidates;
  return (c && c[0] && c[0].url) || null;
}
function carouselOf(m) {
  if (!m.carousel_media) return null;
  return m.carousel_media.map((ch) => ({
    media_type: mediaTypeName(ch),
    image: bestImage(ch),
    video: (ch.video_versions && ch.video_versions[0] && ch.video_versions[0].url) || null,
  }));
}
```

In `lite(m)`, add to the returned object:
```js
    media_type: mediaTypeName(m),
    image: bestImage(m),
    carousel: carouselOf(m),
    taken_at: m.taken_at != null ? m.taken_at : (m.taken_at_timestamp != null ? m.taken_at_timestamp : null),
```
And change the resend signature line in `scan()` to include type:
```js
const sig = `${r.like_count}|${r.comment_count}|${!!r.video}|${r.media_type}`;
```

- [ ] **Step 2: Rework `bridge.js` storage + add responder**

Replace the `igMedia` object with a deduped, surface-stamped store and add the `FBW_IG_LIST` handler. Keep `igMedia[code]`-style lookup for `publishCurrent` by retaining a by-key index.

```js
// canonical id -> record (deduped); insertion order preserved for the list
const byId = new Map();
const igMedia = {}; // code/pk -> record (existing lookups, e.g. publishCurrent)

function surfaceKey() {
  const p = location.pathname;
  let m;
  if ((m = p.match(/\/explore\/tags\/([^/]+)/))) return "tag:" + decodeURIComponent(m[1]);
  if (p.startsWith("/explore")) return "explore";
  if ((m = p.match(/^\/([^/]+)\/?(?:reels\/?)?$/))) {
    const u = m[1];
    if (!["explore", "reels", "p", "reel", "direct", "stories", "accounts"].includes(u)) return "profile:" + u;
  }
  return "feed";
}

// in the window "message" listener that ingests __fbwIg records:
for (const r of e.data.records || []) {
  r.surface = surfaceKey();
  const id = r.code || r.pk;
  if (id) byId.set(id, { ...(byId.get(id) || {}), ...r });
  if (r.code) igMedia[r.code] = r;
  if (r.pk) igMedia[r.pk] = r;
}
```

Add to the existing `chrome.runtime.onMessage` listener (the one handling `FBW_RUN_*`/`FBW_PING`):
```js
if (msg?.type === "FBW_IG_LIST") {
  sendResponse({ records: Array.from(byId.values()), surface: surfaceKey() });
  return; // sync response
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual verification (live IG)**

Load `dist/`. Open `instagram.com/explore/tags/tarot`, scroll a few screens. In the IG tab devtools console:
```js
chrome.runtime.sendMessage; // sanity
```
From the side panel (IgSortTool), confirm the list populates with cards and the "N collected · tag:tarot" counter climbs as you scroll. Open a profile (e.g. an account grid), confirm surface flips to `profile:<user>` and its posts list. (Programmatic cross-check: in the isolated content-script context, `FBW_IG_LIST` returns a non-empty `records` array.)

- [ ] **Step 5: Commit**

```bash
git add src/content/ig/main-world.js src/content/ig/bridge.js
git commit -m "feat: IG capture — media_type/image/carousel + FBW_IG_LIST surface list"
```

---

## Task 7: Background `FBW_DL_MEDIA` download handler

**Files:**
- Modify: `src/background.js` (add one `case` to the `chrome.runtime.onMessage` switch)

**Interfaces:**
- Consumes: `FBW_DL_MEDIA { kind:'video'|'image', url, filename, fallbackUrl? }`.
- Produces: `sendResponse({ ok:true })` or `{ ok:false, error }`.

- [ ] **Step 1: Add the handler**

Inside the `switch (msg?.type)` in `background.js`, add:

```js
    case "FBW_DL_MEDIA": {
      (async () => {
        try {
          if (msg.kind === "video") {
            await chrome.downloads.download({ url: msg.url, filename: msg.filename });
            sendResponse({ ok: true });
            return;
          }
          // image: fetch in the SW (host perms bypass page CORS) → base64 data URL.
          let res = await fetch(msg.url).catch(() => null);
          if ((!res || !res.ok) && msg.fallbackUrl) res = await fetch(msg.fallbackUrl).catch(() => null);
          if (!res || !res.ok) throw new Error("fetch failed " + (res ? res.status : "network"));
          const buf = new Uint8Array(await res.arrayBuffer());
          let bin = ""; const CH = 0x8000;
          for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
          const type = res.headers.get("content-type") || "image/jpeg";
          const dataUrl = `data:${type};base64,${btoa(bin)}`;
          await chrome.downloads.download({ url: dataUrl, filename: msg.filename });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async
    }
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Manual verification (live IG)**

With the IG list populated (Task 6), click a card's ⬇: a video post saves `ig-<user>-<code>.mp4`; a photo saves `.jpg`; a carousel saves `_1/_2…` files. Click **⬇ All** on a short sorted list → each item downloads in sequence.

- [ ] **Step 4: Commit**

```bash
git add src/background.js
git commit -m "feat: FBW_DL_MEDIA background download (video direct / image base64 / carousel)"
```

---

## Task 8: Shell + Launcher + wire everything into `App.jsx`

**Files:**
- Create: `src/components/ui/Launcher.jsx`
- Create: `src/components/ui/ToolFrame.jsx`
- Create: `src/components/Shell.jsx`
- Modify: `src/App.jsx` (→ mount `<Shell/>`)

**Interfaces:**
- Consumes: `PLATFORMS, PLATFORM_ORDER` from `@/lib/platforms`; `toolsForPlatform, globalTools, getTool` from `@/lib/tools`.
- `Launcher({ mode:'platforms'|'tools', items, onPick })` — grid of cards.
- `ToolFrame({ title, onBack, platform, onSwapPlatform, children })`.
- `Shell()` — nav state machine `{screen:'home'|'hub'|'tool', platform, tool}`, persisted to `chrome.storage.local.sw_nav`; theme retint on platform change.

- [ ] **Step 1: Implement `Launcher.jsx`**

```jsx
import { PLATFORMS } from "@/lib/platforms";

export default function Launcher({ mode, items, onPick }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((it) => {
        const Icon = it.Glyph || it.Icon;
        return (
          <button key={it.id} onClick={() => onPick(it.id)}
            className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card p-4 hover:bg-accent transition-colors">
            {Icon ? <Icon className="size-6" /> : null}
            <span className="text-xs font-medium">{it.name || it.label}</span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Implement `ToolFrame.jsx`**

```jsx
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import PlatformSwitcher from "@/components/ui/PlatformSwitcher";

export default function ToolFrame({ title, onBack, platform, onSwapPlatform, children }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> {title}
        </button>
        {platform ? <PlatformSwitcher value={platform} onValueChange={onSwapPlatform} /> : null}
      </div>
      {children}
    </div>
  );
}
```

> `PlatformSwitcher` already exists; confirm its `value`/`onValueChange` props. When the swapped platform doesn't support the current tool, `Shell.onSwapPlatform` falls back to that platform's hub (Step 3).

- [ ] **Step 3: Implement `Shell.jsx`**

```jsx
import { useEffect, useState } from "react";
import { PLATFORMS, PLATFORM_ORDER } from "@/lib/platforms";
import { toolsForPlatform, globalTools, getTool } from "@/lib/tools";
import Launcher from "@/components/ui/Launcher";
import ToolFrame from "@/components/ui/ToolFrame";

const NAV_KEY = "sw_nav";

export default function Shell() {
  const [nav, setNav] = useState({ screen: "home", platform: null, tool: null });
  const [ready, setReady] = useState(false);

  // restore last location
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) { setReady(true); return; }
    chrome.storage.local.get(NAV_KEY).then((r) => { if (r?.[NAV_KEY]) setNav(r[NAV_KEY]); setReady(true); });
  }, []);
  useEffect(() => { if (ready) chrome.storage?.local?.set({ [NAV_KEY]: nav }); }, [nav, ready]);

  // theme retint on platform change
  useEffect(() => {
    if (!nav.platform || !PLATFORMS[nav.platform]) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(PLATFORMS[nav.platform].theme)) root.style.setProperty(k, v);
  }, [nav.platform]);

  if (!ready) return null;

  const goHome = () => setNav({ screen: "home", platform: null, tool: null });

  // HOME — platforms + a Library card
  if (nav.screen === "home") {
    const platformItems = PLATFORM_ORDER.map((id) => ({ id, name: PLATFORMS[id].name, Glyph: PLATFORMS[id].Glyph }));
    const libraryItems = globalTools().map((t) => ({ id: `tool:${t.id}`, label: t.label, Icon: t.Icon }));
    return (
      <Chrome>
        <Launcher mode="platforms" items={platformItems}
          onPick={(id) => setNav({ screen: "hub", platform: id, tool: null })} />
        <div className="mt-3">
          <Launcher mode="tools" items={libraryItems}
            onPick={(pid) => setNav({ screen: "tool", platform: null, tool: pid.replace("tool:", "") })} />
        </div>
      </Chrome>
    );
  }

  // HUB — a platform's tools
  if (nav.screen === "hub") {
    const items = toolsForPlatform(nav.platform).map((t) => ({ id: t.id, label: t.label, Icon: t.Icon }));
    return (
      <Chrome>
        <ToolFrame title={PLATFORMS[nav.platform].name} onBack={goHome} platform={null}>
          <Launcher mode="tools" items={items} onPick={(tid) => setNav({ ...nav, screen: "tool", tool: tid })} />
        </ToolFrame>
      </Chrome>
    );
  }

  // TOOL
  const tool = getTool(nav.tool);
  if (!tool) { goHome(); return null; }
  const Panel = tool.Panel;
  const backTo = tool.platforms === "global"
    ? goHome
    : () => setNav({ screen: "hub", platform: nav.platform, tool: null });
  const onSwap = (p) => {
    if (toolsForPlatform(p).some((t) => t.id === tool.id)) setNav({ screen: "tool", platform: p, tool: tool.id });
    else setNav({ screen: "hub", platform: p, tool: null });
  };
  return (
    <Chrome>
      <ToolFrame title={tool.label} onBack={backTo}
        platform={tool.platforms === "global" ? null : nav.platform} onSwapPlatform={onSwap}>
        <Panel platform={nav.platform} />
      </ToolFrame>
    </Chrome>
  );
}

// Shared header chrome (logo + wordmark).
function Chrome({ children }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-4 pt-4 pb-2.5">
        <div className="flex items-center gap-2.5">
          <div className="grad-identity size-7 rounded-[9px]" />
          <h1 className="text-[15px] font-semibold grad-identity-text tracking-tight">socialWarmer</h1>
        </div>
      </header>
      <main className="flex-1 px-4 py-3 space-y-3">{children}</main>
    </div>
  );
}
```

- [ ] **Step 4: Replace `App.jsx` body**

```jsx
import Shell from "@/components/Shell";
export default function App() { return <Shell />; }
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: succeeds; no leftover imports of removed App internals.

- [ ] **Step 6: Manual verification (full flow)**

Load `dist/`. Confirm: Home shows FB/IG/TikTok cards + a Library card; tap Instagram → hub shows Warm + "Sort + Download"; open Sort → the IG list works (Tasks 6–7); back returns to hub; reopening the panel restores the last screen; theme retints per platform; Facebook → Warm still runs a session; Library opens Saved/Transcripts/History.

- [ ] **Step 7: Commit**

```bash
git add src/components/Shell.jsx src/components/ui/Launcher.jsx src/components/ui/ToolFrame.jsx src/App.jsx
git commit -m "feat: launcher Shell + tool registry wiring (swiss-knife IA)"
```

---

## Task 9: Cleanup pass

**Files:**
- Modify: `src/App.jsx` (remove now-dead imports/components), `src/components/ui/BottomNav.jsx` (delete if unreferenced)

- [ ] **Step 1:** Grep for orphans: `grep -rn "BottomNav\|MODE_NAME\|StatusChip" src` — remove any now-unused code/exports left behind by the extraction. Keep components still used by `WarmTool`.
- [ ] **Step 2:** `npm run build` → succeeds; `npm test` → green.
- [ ] **Step 3: Commit**
```bash
git add -A src
git commit -m "chore: remove dead BottomNav/App view-switch after Shell migration"
```

---

## Self-Review notes (author)

- **Spec §5.1 Shell** → Task 8. **§5.2 registry** → Task 2. **§5.3 App decomposition** → Tasks 3,4,9.
- **§6.1 passive source / FBW_IG_LIST / surface** → Task 6. **§6.2 lite() extension** → Task 6. **§6.3 sort+list** → Tasks 1,5. **§6.4 download paths** → Tasks 5,7. **§6.5 Saved integration** → Task 5 (`saveToLibrary`).
- **§7 data flow** → Tasks 5–7 end-to-end. **§8 errors** → Task 5 (noTab/empty), Task 7 (403 fallback). **§9 testing** → Tasks 1,2 (vitest) + manual steps. **§10 file plan** → matches File Structure above. **§ App.B message API** (`FBW_IG_LIST`, `FBW_DL_MEDIA`) → Tasks 6,7.
- **Correction vs spec:** spec §6.3 mentioned pinkit `/originals/` upscaling for IG; IG's `image_versions2.candidates[0]` is already full-res, so IG uses that directly (no `/originals/` transform — that pattern is Pinterest-specific, Spec 2). `bestImageUrl` was therefore dropped in favor of `recordToCard`'s direct `image`.
- **Type consistency:** record fields (`code, pk, username, full_name, like_count, comment_count, play_count, taken_at, media_type, image, video, thumb, carousel, surface`) are produced in Task 6 and consumed identically in Tasks 1,5. Messages `FBW_IG_LIST`/`FBW_DL_MEDIA` shapes match across Tasks 5,6,7.
