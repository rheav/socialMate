# Per-platform workspaces + live tab following — Design

- **Date:** 2026-07-25
- **Status:** Approved (user: plan thoroughly, perf + reliability first, do not break what works)
- **Version target:** 0.63.0 (MINOR — new shell behavior, no engine changes)

## 1. Problem

The side panel does not follow the browser. Concretely, from reading the code:

1. **Platform is detected once, on mount.** `Shell.jsx:71` calls
   `detectActivePlatform()` inside a mount-only `useEffect`. There are **no**
   `chrome.tabs.onActivated` / `onUpdated` listeners anywhere in `src/`. Switching
   from a TikTok tab to an Instagram tab leaves the panel on TikTok; the user must
   manually go back to Platforms and re-pick.
2. **Nav state is flat and has no per-platform memory.** `sw_nav2` holds a single
   `{tab, platform, toolId}` (`Shell.jsx:86`), and `toolId` is explicitly reset to
   `null` on every platform change (`Shell.jsx:164`, `Shell.jsx:194`). So even after
   manually switching back, you land on the platform's *first* tool, not the one you
   were using.

Desired: three independent workspaces (one per platform); the panel mirrors the
active tab's platform; returning to a platform resumes where you left off.

## 2. Non-goals (explicitly out of scope)

- **Per-platform retinting.** `platforms.jsx` defines a `THEMES` map with
  per-platform `--sw-*` vars and a comment claiming it is "Applied to `<html>` on
  switch", but **nothing applies it** (no `setProperty` / `documentElement.style`
  anywhere in `src/`). The identity gradient is whatever `index.css :root` sets
  (FB blue in light, Brute red→yellow in dark) on every platform. Wiring the retint
  would restyle the entire panel — a visual change the user did not ask for. Left
  untouched; documented here so it is not mistaken for a regression.
- Preserving deep per-tool UI state (search text, expanded buckets, scroll offset).
  See §4.3 for why, and what is preserved instead.
- Any change to `content.js`, the bridges, background, or the tools' own data flow.

## 3. State model

New storage key **`sw_nav3`** (new key, so a malformed/old value can never corrupt
the new shape; `sw_nav2` is read once for migration and then simply ignored):

```js
{
  tab: "warm" | "library",         // top-level tab — GLOBAL, not per-platform
  platform: "facebook" | "instagram" | "tiktok" | null,  // workspace on screen
  perPlatform: {                   // independent memory per platform
    facebook:  { toolId: "warm" },
    instagram: { toolId: "ig-sort" },
    tiktok:    { toolId: "tt-comments" },
  },
}
```

- `tab` stays global: being in Library is a deliberate mode, and switching browser
  tabs must not yank the user out of it (§4.2).
- `perPlatform[p].toolId` is the resumable position. Unknown/stale tool ids are
  tolerated: `WarmTab` already falls back to `tools[0].id` when the saved id isn't
  in the platform's registry (`Shell.jsx:190`), which also covers a tool being
  renamed or removed in a later version.

All transitions live in a new **pure** module `src/lib/navState.js`:

| function | contract |
|---|---|
| `emptyNav()` | fresh default state |
| `normalizeNav(n)` | defensive: coerce bad `tab`, drop unknown platforms, prune junk |
| `migrateNav(v3, v2)` | prefer v3; else seed from legacy `sw_nav2`; else empty |
| `toolIdFor(nav, p)` | saved tool id for a platform, or `null` |
| `withPlatform(nav, p)` | switch workspace |
| `withToolId(nav, p, id)` | remember a tool for a platform |
| `withTab(nav, tab)` | switch top-level tab |

**Identity-preserving no-ops.** Every `with*` returns the **same object reference**
when nothing would change. `setNav(n => withPlatform(n, p))` with an unchanged `p`
therefore triggers **zero re-renders** (React bails on `Object.is` equality). This
is the main defense against event-storm churn (§5.1) and is unit-tested.

## 4. Behavior

### 4.1 Following the active tab

The panel switches workspace whenever the active tab of **its own window** resolves
to a supported platform different from the one on screen.

Event sources (all panel-local — see §5.2 for why not the background):

| source | why |
|---|---|
| `chrome.tabs.onActivated` | user switches tab |
| `chrome.tabs.onUpdated` (only when `changeInfo.url` and `tab.active`) | active tab navigates in place (tiktok.com → instagram.com) |
| `document.visibilitychange` → visible | cheap safety net; re-syncs after the panel was hidden and any event was missed |

`chrome.windows.onFocusChanged` is **deliberately not used**. The side panel is
scoped to a window, and `chrome.tabs.query({active:true, currentWindow:true})` from
the panel resolves against the panel's own window. Reacting to another window
gaining focus would make panel A follow window B's tab — a wrong update. Both tab
listeners additionally filter on the panel's own `windowId`, captured once via
`chrome.windows.getCurrent()`.

### 4.2 What does NOT change on a tab switch

- **Library.** If `tab === "library"`, the workspace platform still updates
  underneath, but the visible view does not change. Going back to Warmer then shows
  the right platform. Non-destructive by construction.
- **Non-platform tabs are sticky.** Switching to gmail/localhost/etc. resolves to
  `null` → the handler returns early and the panel keeps the last workspace.
  Blanking the panel on every unrelated tab would be hostile.
- **Manual switcher picks** are honored; they just aren't permanent. The rule is
  simply "the panel mirrors the active tab's platform when that tab is a supported
  platform", so a manual pick shows another platform's workspace until the next tab
  switch/navigation. Predictable, and no hidden pin state to reason about.
- **Home (`platform === null`)** follows into the detected workspace — identical to
  today's mount behavior, just now also on tab change.

### 4.3 Depth of "resume"

Preserved: the platform's selected tool (`toolId`).

Not preserved: each tool's internal React state (search query, sort key, expanded
rows). Rejected approach — keeping all three platforms mounted and CSS-hiding the
inactive ones — because **every data tool polls its tab on a 2.5 s interval**
(`IgSortTool.jsx:131`, `TtSortTool`, `TtCommentsTool`, `TtStoriesTool`,
`TtCollectionsTool`, plus `IgStoriesTool`). Mounting three platforms at once would
multiply live intervals and `chrome.tabs.sendMessage` traffic ~3×, permanently, to
save state that each tool re-populates from its bridge within one poll. That is a
clear perf regression for a marginal gain, so exactly one platform's tools stay
mounted — unchanged from today.

Persisting cheap per-tool *preferences* (sort key/direction) is a possible additive
follow-up; not in this change.

## 5. Performance & reliability

### 5.1 Churn control
- **150 ms debounce** on the sync. `onUpdated` fires repeatedly during a navigation
  (status/title/favicon); one `tabs.query` per burst, not per event.
- **`onUpdated` pre-filter**: ignore unless `changeInfo.url` is present and the tab
  is `active` and in our window — cuts the vast majority of events before any async
  work.
- **No-op guard** (§3): resolving the same platform produces no state change and no
  re-render.
- **Debounced persist** (300 ms) so a burst of switches writes `sw_nav3` once.
  (`chrome.storage.local` has no per-minute write cap — unlike `sync` — but this
  keeps I/O proportional to intent.)

### 5.2 Why listeners live in the panel, not the background
The background SW is MV3 and sleeps. Registering tab listeners there would wake it
on every tab switch **even when the panel is closed**, then require a storage write
plus a `storage.onChanged` round-trip to reach the panel. Panel-local listeners cost
nothing when the panel is closed (correct — there is nothing to update) and remove
an entire indirection layer. The background keeps doing only what it does today.

### 5.3 Async race
`detectActivePlatform()` is async. Rapid tab switching can resolve out of order and
apply a stale platform. Guarded by a monotonic sequence ref: each sync takes a
ticket, and a resolution whose ticket is no longer current is dropped. Also a
`dead` flag set on cleanup so an in-flight resolve can't `setState` after unmount.

### 5.4 Failure modes
| case | handling |
|---|---|
| `chrome.tabs.query` throws (window teardown) | try/catch, ignore; next event re-syncs |
| `chrome.windows.getCurrent()` unavailable | `ownWindowId` stays `null` → window filter degrades to "accept all" rather than breaking following |
| corrupt/absent `sw_nav3` | `normalizeNav` coerces; worst case `emptyNav()` |
| saved `toolId` no longer registered | existing `tools[0]` fallback (`Shell.jsx:190`) |
| no `chrome.tabs` (dev/browser preview) | `hasChromeTabs()` guard; listeners never attach |

### 5.5 Blast radius / rollback
New file `lib/navState.js` (pure) + `Shell.jsx` rewiring + three cosmetic edits
(§6). **No** changes to content scripts, bridges, background, or any tool's data
path. Reverting = restore `Shell.jsx` and delete `navState.js`; `sw_nav3` becomes an
ignored orphan key and `sw_nav2` is still intact.

## 6. UI changes (bundled, user-requested)

1. **Platform switcher moves into the header**, right of the `socialMate` wordmark
   (out of `ToolFrame`). It becomes always-visible primary nav — which pairs with
   auto-follow: you can always see which platform the panel is on. At Home nothing
   glows; clicking a glyph sets `tab="warm"` + that platform. `ToolFrame` keeps its
   `‹ Platforms` back button and simply stops rendering the switcher.
2. **Flame glyph inside the identity squircle.** The header's
   `<div class="grad-identity size-7 rounded-[9px]" />` is currently empty; add a
   centered white `Flame` icon (matches the extension icon in the screenshot).
3. **`"Sort + Download"` → `"Sort"`** for both `ig-sort` and `tt-sort` (download is
   implicit), and **`Segmented` buttons get `min-w-0`**. Root cause of the clipped
   5th TikTok tab: flex items default to `min-width:auto`, so the buttons refuse to
   shrink below their content and the existing `truncate` never engages, overflowing
   the track. `min-w-0` lets truncation work; the shorter label removes the pressure
   in the first place.

## 7. Testing

**Unit (vitest, `navState.test.js`)** — migration from v2 → v3, per-platform toolId
memory (set IG tool, switch to TT, switch back), identity-preserving no-ops
(`withPlatform(nav, same) === nav`), `normalizeNav` rejecting unknown platforms and
bad `tab`, `toolIdFor` on empty state.

**Live (chrome-devtools MCP, 3 real tabs)** —
1. FB / IG / TT tabs open; activate each in turn → panel workspace follows.
2. On IG pick `Stories`, on TT pick `Comments`, switch back and forth → each
   platform resumes its own tool.
3. Enter Library, switch tabs → Library stays on screen; return to Warmer shows the
   new platform.
4. Switch to a non-platform tab → panel unchanged (sticky).
5. Navigate one tab in place (tiktok.com → instagram.com) → panel follows.
6. Confirm the 5 TikTok tabs fit with no clipping, header switcher + flame render.
