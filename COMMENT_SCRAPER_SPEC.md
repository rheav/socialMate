# Facebook Comment Scraper — Spec + Implementation Plan

Scrape the **comment thread of a single open Facebook reel/post** into a JSON file,
for mining hooks / objections / sentiment from the audience's own words.

**Locked decisions (from brainstorming):**

| Decision | Choice |
|---|---|
| Purpose | **Text corpus** — comment text + reactions, for hook/objection/sentiment mining |
| Replies | **Included** (nested, tagged with parent) |
| Scope per run | **Single open post/reel** (no bulk profile walk) |
| Platform | **Facebook only** (IG deferred) |
| Export | **JSON** file download |
| Trigger | **On-page floating button** on the reel/post |
| Reactions | **Total count only** (no per-type breakdown) |
| Capture method | **DOM-only** (no JSON.parse hook in v1) |

> Status: **approved, building.** No further confirmation gates (user waived them).

---

## 1. Why this works (verified live)

Monitored the flow on `facebook.com/reel/1007457378347678` (571 comments):

- Comment pagination (`CommentsListComponentsPaginationQuery`) and reply pagination
  (`Depth1/Depth2CommentsListPaginationQuery`) **parse on the main thread** — 76
  comment payloads passed through `JSON.parse`. (Unlike the feed/reels-grid, which
  paginate off-thread.) So both the DOM and a JSON.parse hook are viable; we use the
  **DOM** for v1 (robust, locale-tolerant, no MAIN-world plumbing).
- Each comment renders as `[role="article"]` with `aria-label` =
  `"Comentário de <name> há <time>"` (localized). Everything we need is in the DOM:
  author name, author profile URL + id, comment text, reactions count
  (`aria-label "22 reações, veja quem reagiu a isso"`), relative time, top-fan badge
  (`Superfã`), reply toggles (`Ver N respostas`), and the comment permalink
  (`?comment_id=`).
- Default sort is `Mais relevantes` (Most relevant). Switching to
  `Todos os comentários` / `Mais recentes` (All / Newest) yields the complete set.

---

## 2. Data model

Per-comment record (all DOM-sourced):

```json
{
  "comment_id": "1234567890_0987654321",
  "permalink": "https://www.facebook.com/reel/<id>/?comment_id=...",
  "author": { "name": "Melanie May", "url": "https://www.facebook.com/melanie.may.528", "id": "melanie.may.528" },
  "text": "You'll never find me tolerating…",
  "reactions": 22,
  "time_relative": "4 sem",
  "is_reply": false,
  "parent_id": null,
  "badges": ["Superfã"]
}
```

Export envelope:

```json
{
  "post_url": "https://www.facebook.com/reel/1007457378347678",
  "post_id": "1007457378347678",
  "scraped_at": "2026-07-18T13:40:00.000Z",
  "sort_mode": "all",
  "count": 512,
  "reply_count": 143,
  "comments": [ /* records, top-level then its replies grouped after it */ ]
}
```

Field notes:
- `reactions` — integer parsed from the reactions aria-label; `0` when none.
- `time_relative` — kept as FB's localized string ("4 sem", "2 h"). Exact timestamps
  would need the JSON.parse hook — out of scope for v1.
- `is_reply` / `parent_id` — a reply is an article nested under a top-level article (or
  inside its reply container); `parent_id` = the enclosing top-level comment's id.
- `badges` — e.g. `["Superfã"]` (top fan). Best-effort.

---

## 3. Architecture

```
src/
  content/fb/comments-scrape.js   NEW — floating button + harvest + reply expansion (isolated world)
  lib/fbComments.js               NEW — pure helpers (unit-tested)
  lib/fbComments.test.js          NEW
background.js                     CHANGED — add FBW_DL_JSON download handler
manifest.config.js               CHANGED — register the content script (no new permissions)
```

### 3.1 `lib/fbComments.js` (pure, DOM-free, tested)

| Function | Contract |
|---|---|
| `parseReactions(ariaLabel)` | `"22 reações, veja…"` → `22`; `null`/no-number → `0`. Handles localized abbreviations via the existing count logic. |
| `parseAuthorFromAria(ariaLabel)` | `"Comentário de Melanie May há 4 semanas"` → `{ name: "Melanie May", time: "4 semanas" }`. Locale set: pt/en/es/fr/it prefixes (`Comentário de` / `Comment by` / `Comentario de` / `Commentaire de` / `Commento di`). |
| `cleanAuthorUrl(href)` | strip `?comment_id`/tracking → clean profile URL; derive `id` (`profile.php?id=` or vanity slug). |
| `commentIdFromHref(href)` | pull `comment_id=<id>` (and `reply_comment_id`) from any comment link. |
| `dedupeKey(rec)` | `comment_id` when present, else `author.id + '|' + text.slice(0,40)`. |
| `buildExport(postMeta, records)` | assemble the envelope (§2), replies grouped after their parent, stable order. |
| `filenameFor(postId)` | `socialmate-comments/fb-<postId>-<YYYY-MM-DD_HH-mm-ss>.json`. |

### 3.2 `content/fb/comments-scrape.js` (isolated content script)

Import-free (FB CSP), init-guarded (`window.__fbwCommentsInit`), generation-takeover
guard (reuse the pattern already in `transcription/inject.js` so an extension reload
doesn't leave two scrapers fighting). Responsibilities:

1. **Surface + button.** Show a floating **"Scrape comments"** button on comment-bearing
   surfaces only: `/reel/<id>`, `/watch`, `?v=<id>`, and post permalinks
   (`/posts/`, `/videos/`, `story_fbid`). Style mirrors the existing `.fbw-thumbbtn`
   floating button. Hidden elsewhere. Removed on SPA navigation away.
2. **Open comments.** If no comment article is present, click the comment control
   (`[aria-label]` matching `Comentar`/`Comment`) and wait for the panel.
3. **Sort for completeness (best-effort).** Open the comment sort dropdown and pick
   `Todos os comentários` / `All comments` / `Mais recentes` / `Newest`; record which
   `sort_mode` was used (`all` / `newest` / `relevant`). Skip silently if not found.
4. **Harvest loop.** Repeatedly: scroll the comment scroller to its bottom, wait for
   growth, collect every comment `[role="article"]`, dedupe by key. Live count on the
   button ("Scraping… 240"). Stop when the count is stable for 4 passes or a hard cap
   (~250 iterations) hits. Re-click the button = **cancel** (resolves with what's
   gathered).
5. **Expand replies.** Click every `Ver N respostas` / `Ver mais respostas` /
   `View N replies` toggle, wait, then harvest the newly-revealed reply articles,
   tagging `is_reply` + `parent_id`. Bounded passes so a huge thread can't loop forever.
6. **Extract per article** (`extractComment(articleEl)`):
   - author name + time ← `parseAuthorFromAria(aria-label)`.
   - author url/id ← first `a[href*="comment_id"]` (the author link) → `cleanAuthorUrl`.
   - `comment_id` ← `commentIdFromHref` over the article's links.
   - reactions ← `parseReactions` of the article's reactions aria-label.
   - badges ← presence of `Superfã` / `Top fan` text.
   - **text** ← the `div[dir="auto"]` block inside the article that is NOT a link
     (author), NOT the time, NOT a button (`Responder`/reply), NOT a badge, and does
     NOT contain a nested `[role="article"]`; choose the longest such block. **This is
     the one heuristic to verify live** (see §5).
7. **Export.** Build the envelope via `buildExport`, send
   `{ type: "FBW_DL_JSON", filename, data }` to the background.

### 3.3 `background.js` — `FBW_DL_JSON`

Mirror the existing run-log writer (`writeRunLogFile` → `jsonDataUrl` → `chrome.downloads`):

```js
case "FBW_DL_JSON": {
  try {
    chrome.downloads.download({
      url: jsonDataUrl(msg.data),
      filename: msg.filename,          // e.g. socialmate-comments/fb-<id>-<stamp>.json
      saveAs: false,
      conflictAction: "uniquify",
    });
    sendResponse({ ok: true });
  } catch (e) { sendResponse({ ok: false, error: e.message }); }
  return false;
}
```

`jsonDataUrl` already exists (TextEncoder → base64 data URL; SW has no `URL.createObjectURL`).
`downloads` permission is already granted.

### 3.4 `manifest.config.js`

Add a content-script entry for `src/content/fb/comments-scrape.js` matched to
`*://*.facebook.com/*`, `run_at: document_idle`. Bump version. No new permissions.

---

## 4. Edge cases & safety

- **Human-paced scroll.** Reuse jittered waits (~700–1200ms) between scrolls so the
  harvest doesn't hammer FB; the whole point is passive reading of what's already loaded.
- **Cancel.** Second button click sets a cancel flag; the loop exits and still exports
  what it has.
- **Runaway cap.** Hard iteration cap + stable-count stop so a 10k-comment post can't spin.
- **Deleted/edited/anonymous comments.** Missing author link → `author.id`/`url` null,
  keep the text. Missing text (sticker/GIF-only) → `text: ""`, still recorded with
  reactions.
- **Locale.** All matching via `aria-label` prefixes + a small localized word set
  (pt/en/es/fr/it), consistent with the rest of the codebase.
- **Not on a comment surface.** Button hidden; nothing runs.

---

## 5. The one thing to verify live during build

`extractComment` text isolation. FB's comment article `innerText` is
`"<name> · <time> · <badge> · <text> · Responder"`. The plan is: among the article's
`div[dir="auto"]` blocks, take the longest that isn't a link/button/time/badge and holds
no nested article. **Verify on the 571-comment reel**, tune the exclusion set, confirm
top-level vs reply attribution, then lock it. Everything else (author, reactions, id,
count) is already confirmed present in the DOM.

---

## 6. Implementation plan (phases)

**Phase 1 — pure lib + tests.**
`lib/fbComments.js` + `lib/fbComments.test.js`: `parseReactions`, `parseAuthorFromAria`,
`cleanAuthorUrl`, `commentIdFromHref`, `dedupeKey`, `buildExport`, `filenameFor`.
Done-when: `vitest` green for all; localized inputs covered.

**Phase 2 — background download handler.**
Add `FBW_DL_JSON` to `background.js` (reuse `jsonDataUrl`). Done-when: a test message
writes a JSON file to `~/Downloads/socialmate-comments/`.

**Phase 3 — content script.**
`content/fb/comments-scrape.js`: button, surface gate, open-comments, sort-for-all,
harvest loop, reply expansion, `extractComment`, export. Register in manifest, bump
version. Done-when: builds clean, button appears on a reel.

**Phase 4 — live verification (the reel).**
Reopen `facebook.com/reel/1007457378347678`, run a scrape, confirm: count approaches the
571 shown, text isolated correctly, replies tagged with parents, reactions parsed, JSON
downloads with the right shape. Tune `extractComment` against reality.

**Phase 5 — changelog + build.** Bump `manifest.config.js` + `package.json`, CHANGELOG
entry, `npm run build`, reload, final live pass.

---

## 7. Task checklist

- [ ] `lib/fbComments.js` pure helpers + `lib/fbComments.test.js`
- [ ] `background.js` `FBW_DL_JSON` handler
- [ ] `content/fb/comments-scrape.js` (button + harvest + replies + extract + export)
- [ ] `manifest.config.js` content-script entry + version bump
- [ ] Live verify on the 571-comment reel; tune `extractComment`
- [ ] CHANGELOG + build + reload + final pass

---

*Deliberately out of scope for v1: Instagram, bulk/profile walk, per-type reaction
breakdown, exact timestamps, CSV, persisting into the Library. Each is an additive follow-up.*
