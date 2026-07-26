> **STATUS: NOT BUILT, AND NOW PARTLY STALE.** Planned 2026-07-16; 30+ releases
> have shipped since without any PocketBase code. Its real remaining asset is the
> §4-5 storage audit — and that audit predates the 0.65.0 store-cap rework, the
> TikTok/Pinterest write paths, and 0.69.0 moving every `fbw_saved` write behind the
> background worker, so REFRESH §4-5 FIRST if this is ever picked up. Other known
> drift: the `platform` enum has no `pinterest`, and the hardcoded extension id
> changes on Web Store publish. See `docs/ARCHITECTURE.md` for the current storage
> registry.

# PocketBase Migration Plan — socialMate

Moving the research **library** (transcripts + saved videos) from `chrome.storage.local`
to a self-hosted **PocketBase** database on the user's VPS, so the library survives
across devices and browser reinstalls.

**Chosen configuration (locked):**

- **Users:** personal, multi-device — a single PocketBase account (yours), used from
  every device you run the extension on. No signup flow, no email verification.
- **Sync model:** **write-through cache** — `chrome.storage.local` stays the local
  mirror and the offline-safe capture target; the background service worker pushes
  changes to PocketBase with a retry queue. PocketBase is the cross-device source of
  truth. No realtime (SSE) push.

> Status: **planned, not built.** This doc is the spec. The VPS/EasyPanel/DNS steps are
> yours (they need credentials/host access). The extension code, the collection schema
> + rules, and the backfill migration are mine to write once the instance is reachable.

---

## Table of contents

1. [Why / goals / non-goals](#1-why--goals--non-goals)
2. [What PocketBase is](#2-what-pocketbase-is)
3. [Reusing the unfunnelizer backend — verdict](#3-reusing-the-unfunnelizer-backend--verdict)
4. [What data moves and what stays](#4-what-data-moves-and-what-stays)
5. [Current storage surface (audit)](#5-current-storage-surface-audit)
6. [Target data model (collections + rules)](#6-target-data-model-collections--rules)
7. [Server deployment on the VPS (EasyPanel + Docker)](#7-server-deployment-on-the-vps-easypanel--docker)
8. [Extension architecture changes](#8-extension-architecture-changes)
9. [Auth model + token persistence](#9-auth-model--token-persistence)
10. [Write-through sync + retry queue](#10-write-through-sync--retry-queue)
11. [Startup hydration + reads](#11-startup-hydration--reads)
12. [Thumbnails: file field vs inline base64](#12-thumbnails-file-field-vs-inline-base64)
13. [Backfill migration of existing local data](#13-backfill-migration-of-existing-local-data)
14. [Manifest / CSP / host permissions](#14-manifest--csp--host-permissions)
15. [Security notes](#15-security-notes)
16. [Phasing + effort estimate](#16-phasing--effort-estimate)
17. [Task checklist](#17-task-checklist)
18. [Open questions / future](#18-open-questions--future)
19. [Reference snippets](#19-reference-snippets)

---

## 1. Why / goals / non-goals

**Why.** Today the entire research library lives in `chrome.storage.local`, capped at 20
transcripts (rolling). It is per-browser-profile: reinstall the extension, switch
machines, or clear storage and the library is gone. The transcripts (with thumbnails,
captions, author, counts) are the actual product of the tool — worth persisting properly.

**Goals.**

- Durable, cross-device library of transcripts + saved videos.
- Keep the extension fully functional offline — capture must never depend on the server
  being up.
- No UI regressions: the Library/Transcripts/Saved panels keep working exactly as they do.
- Lift the 20-record cap; the DB holds the full history.

**Non-goals (explicitly out for this pass).**

- Multi-user distribution / signup / email verification (single personal account).
- Realtime cross-device push (SSE). A device sees new records on next hydration, not live.
- Migrating transient/device-local state (run session, telemetry, UI prefs, embedding cache).
- Cloud transcription/download compute. Whisper + ffmpeg stay local in the offscreen doc;
  PocketBase stores results only.

---

## 2. What PocketBase is

- Open-source backend in a **single Go binary** embedding **SQLite**. One process, one
  data directory.
- Ships: admin dashboard (`/_/`), a **REST-ish API** (`/api/...`), an official
  **JavaScript SDK** (`npm i pocketbase`), per-collection **access rules**, **realtime**
  over SSE, and **file storage** (local disk or S3).
- Deploy = run the binary (`./pocketbase serve`) or a tiny Docker image. Creates two dirs:
  - `pb_data/` — the SQLite DB **and** uploaded files. This is the entire state to back up.
  - `pb_migrations/` — JS schema migration files (optional; schema can also be edited in the
    dashboard).
- Default port **8090**. First launch prints a superuser setup link → admin dashboard.
- Pre-v1.0.0: full backward compatibility not guaranteed. Pin a version; read release notes
  before upgrading.

---

## 3. Reusing the unfunnelizer backend — verdict

The unfunnelizer project's backend (`back-end/api-v2-docker/`) is a **custom Node app**:
Express + `better-sqlite3` + `@aws-sdk/client-s3` + `nodemailer`, optionally talking to
**Supabase**, deployed as a **Docker app on EasyPanel** from the GitHub repo.

**Can we reuse its code?** No — it is a different stack. PocketBase is its own server; we
do not port the Express/Supabase code into socialMate.

**What DOES transfer (and is why this is low-risk):**

| Reusable asset | How it applies here |
|---|---|
| **EasyPanel deployment pattern** | New EasyPanel app, GitHub/Docker source, persistent volume, env vars, TLS domain. PocketBase drops into the identical workflow — see `back-end/api-v2-docker/EASYPANEL_SETUP.md` for the same steps. |
| **Persistent-volume discipline** | unfunnelizer mounts a data dir for its SQLite; PocketBase needs the same for `pb_data`. |
| **Extension↔backend shape** | unfunnelizer's extension has the background SW own the `fetch` client (`API_BASE_URL`), content/panel message it. socialMate already follows this; PocketBase slots into the same seam. |
| **CORS/origin handling** | unfunnelizer allows `chrome-extension://` origins server-side. PocketBase needs the same allowance. |

**Net:** same VPS, same EasyPanel, same "background owns the network" architecture —
different (simpler) server process.

---

## 4. What data moves and what stays

Only the **research library** is worth a database. Everything else is device-local or
transient and stays in `chrome.storage`.

| Storage key | Move to PB? | Reason |
|---|---|---|
| `fbw_transcripts` | **Yes** | The core artifact: text, chunks, thumb, author, caption, counts. |
| `fbw_saved` | **Yes** (as `saved` bool on the transcript, or a sibling collection) | Favorites/library. |
| `fbw_session` | No | Live run state; per-device, meaningless cross-device. |
| `fbw_events` (`EVENTS_KEY`) | No | Run telemetry buffer; already flushed to `~/Downloads/socialmate-runs/*.json`. |
| `fbw_history` (`HISTORY_KEY`) | No | Local run history (last 50). Could sync later if wanted. |
| `fbw_seen` (`SEEN_KEY`) | Maybe (later) | Cross-session warming dedup. Only sync if you want dedup to follow you across devices. |
| IndexedDB embeddings (`idb-keyval`) | No | Pure recompute cache (MiniLM vectors), keyed by content hash. |
| `sw_theme`, `sw_nav2`, `sw_ig_overlay`, `fbw_need_reload`, `fbw_current` | No | UI prefs / device-local hints. |

**Scope of the move = `fbw_transcripts` (+ the `saved` flag).** That is the whole
migration surface. This keeps blast radius small.

---

## 5. Current storage surface (audit)

Where the library data is read/written today (so we know every call site to route through
the new layer):

**Writes to `fbw_transcripts`:**

- `src/background.js` — `putTranscript(videoId, patch)` is the single funnel for
  status/text/chunks/metadata. Already rolling-capped at 20 (`TRANSCRIPTS_CAP`). **This is
  the primary hook point for write-through.**
- `src/content/transcription/inject.js` — `writeRunningRecord(msg)` writes an eager
  "running" card at click time (instant Library feedback) and `saveFavorite(meta)` writes
  `fbw_saved`.

**Reads of `fbw_transcripts` / `fbw_saved`:**

- `src/components/TranscriptsPanel.jsx` — `useStore(TKEY)` / `useStore(SKEY)`: reads the map,
  subscribes to `chrome.storage.onChanged`, renders the grid. `patchMap()` toggles save /
  deletes. Clear-all writes `{}`.
- `src/components/tools/IgSortTool.jsx` — reads `["fbw_transcripts","fbw_saved"]`.
- `src/content/ig/bridge.js` — reads/writes `fbw_saved` for the IG on-page overlay.
- `src/content/transcription/inject.js` — writes `fbw_saved` on auto-capture favorite.

**Design consequence:** the UI reads `chrome.storage` and reacts to `storage.onChanged`.
If we keep `chrome.storage` as the local mirror (write-through), **none of the panels
change** — they keep reading the mirror; the background just also pushes to PB and pulls on
startup. This is the key reason write-through beats direct-to-PB.

---

## 6. Target data model (collections + rules)

### 6.1 `users` (built-in auth collection)

Use PocketBase's built-in auth collection. Email/password. One record: you.

### 6.2 `transcripts` (base collection)

| Field | Type | Notes |
|---|---|---|
| `owner` | relation → `users` (single, required, cascade delete) | Scopes every record to the account. |
| `platform` | select (`facebook`/`instagram`/`tiktok`) or text | From `meta.platform`. |
| `video_id` | text, required | The platform video id. **Unique per owner** (see index). |
| `author_name` | text | `author.name`. |
| `author_url` | text | `author.url`. |
| `caption` | text (long) | Post caption. |
| `counts` | json | `{ like, comment, share, views }`. |
| `source_url` | text | Permalink back to the reel/video. |
| `text` | text (long) | Full transcript. |
| `chunks` | json | Whisper timestamped chunks (`[{text, timestamp:[start,end]}]`) for `.srt`. |
| `thumb` | **file** (single image) — or text if inline (§12) | 180px JPEG. |
| `status` | select (`running`/`done`/`error`) | Mirrors local record status. |
| `error` | text | Error string when `status = error`. |
| `saved` | bool | Replaces the separate `fbw_saved` map (favorite flag). |
| `captured_at` | number (or date) | `updatedAt` from the local record, for stable ordering. |

Plus PocketBase's automatic `id`, `created`, `updated`.

**Index (critical for upsert semantics):** unique composite on **(`owner`, `video_id`)**.
Re-transcribing the same video updates the existing row instead of duplicating. In the
dashboard: Collection → Indexes → `CREATE UNIQUE INDEX idx_owner_video ON transcripts
(owner, video_id)`.

### 6.3 Access rules (all five)

Every rule identical — the record is visible/writable only by its owner:

```
@request.auth.id != "" && owner = @request.auth.id
```

- `listRule`, `viewRule`, `updateRule`, `deleteRule`: the expression above.
- `createRule`: `@request.auth.id != "" && owner = @request.auth.id`
  (forces the new record's `owner` to be the caller — the SDK sends `owner` = current user id).

Because "API Rules act also as record filter," a `getFullList()` returns only your rows even
without an explicit filter — but we still pass an explicit `owner` filter for clarity.

### 6.4 Optional later: `run_history`, `seen_ids`

If cross-device run history / dedup is wanted later, add collections with the same
owner-scoping. Out of scope for this pass.

---

## 7. Server deployment on the VPS (EasyPanel + Docker)

PocketBase has no official Docker image, so we build a tiny one. Same EasyPanel flow the
unfunnelizer backend uses.

### 7.1 Dockerfile

```dockerfile
# Dockerfile — PocketBase
FROM alpine:3.20

ARG PB_VERSION=0.22.21   # pin an explicit version; bump deliberately

RUN apk add --no-cache ca-certificates unzip wget

WORKDIR /pb
RUN wget -q https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip \
    && unzip pocketbase_${PB_VERSION}_linux_amd64.zip \
    && rm pocketbase_${PB_VERSION}_linux_amd64.zip

EXPOSE 8090

# pb_data holds the SQLite DB + uploaded files → MUST be a persistent volume
CMD ["./pocketbase", "serve", "--http=0.0.0.0:8090"]
```

`.dockerignore`:

```
pb_data
```

### 7.2 EasyPanel steps

1. **New → App**, source = GitHub (repo containing this Dockerfile) or a Dockerfile source.
   If you keep the Dockerfile in a subfolder, set the **Build Path** to that folder
   (mirrors unfunnelizer's `back-end/api-v2-docker` build path).
2. **Persistent volume:** mount a volume at **`/pb/pb_data`**. Without this, every redeploy
   wipes the DB. (Same discipline as unfunnelizer's data dir.)
3. **Domain:** add `pb.yourdomain.com`; EasyPanel/Traefik provisions TLS. Point the service
   port to **8090**.
4. **Env:** none strictly required. PocketBase reads flags/superuser from first-run. Set a
   timezone if you like.
5. Deploy. Open `https://pb.yourdomain.com/_/`, complete the **superuser** setup, then
   create **one** regular account in the `users` collection for the extension to log in as.

### 7.3 Collections + rules

Create `transcripts` per §6 (dashboard, or paste a migration — see §19.4). Set the unique
`(owner, video_id)` index and the five owner-scoped rules.

### 7.4 CORS

Settings → allow the extension origin. Add:

```
chrome-extension://cmaidhikebdolakdmipclahbokbokflg
```

(the current unpacked id; if you publish to the Web Store the id changes → add the store id
too). PocketBase must send `Access-Control-Allow-Origin` for this origin or the SDK calls
fail preflight.

### 7.5 Backups

`pb_data` is the whole state. Either snapshot the volume on the VPS, or use PocketBase's
built-in **Settings → Backups** (can push to S3). Mirrors unfunnelizer's `BACKUP_ENABLED`
habit.

---

## 8. Extension architecture changes

New module, one hook point, one hydration call — deliberately small.

```
src/
  lib/
    pb.js            NEW — PocketBase client singleton + ChromeStorageAuthStore + helpers
  background.js      CHANGED — putTranscript() write-through; hydrate on start; sync queue
  components/
    LibraryAuth.jsx  NEW — one-time login screen (email/pass) + logout, shown in Library tab
    TranscriptsPanel.jsx  UNCHANGED (reads chrome.storage mirror as today)
manifest.config.js   CHANGED — host_permissions + CSP connect-src for the PB origin
package.json         CHANGED — add "pocketbase" dependency
```

**Data flow (write path):**

```
content inject.js  ──FBW_TRANSCRIBE──▶  background.runTranscription()
                                            │
                                     putTranscript(id, patch)
                                            │
                     ┌──────────────────────┼───────────────────────┐
                     ▼                                               ▼
        chrome.storage.local  (instant)                   pbUpsertQueued(record)
        → storage.onChanged                                   │
        → panels re-render                          success ─┤ update PB
                                                    fail   ──┘ enqueue retry (local queue)
```

**Data flow (read path):**

```
SW start / panel open  ──▶  pbHydrate()
                              │  pb.collection('transcripts').getFullList({filter: owner})
                              ▼
                    merge into chrome.storage.local  (newer updated wins)
                              ▼
                    storage.onChanged → panels render (unchanged)
```

The panels never talk to PocketBase directly. All PB I/O lives in the background SW via
`lib/pb.js`.

---

## 9. Auth model + token persistence

Single personal account. Log in once; the token is restored from `chrome.storage.local`
thereafter, so subsequent sessions feel login-less until the token expires.

- The SDK's default `LocalAuthStore` uses `localStorage`, which the **service worker does
  not have**. Provide a custom store backed by `chrome.storage.local` (pattern is
  documented in the SDK README):

```js
// src/lib/pb.js
import PocketBase, { BaseAuthStore } from "pocketbase";

const AUTH_KEY = "pb_auth"; // { token, record }

class ChromeAuthStore extends BaseAuthStore {
  constructor() {
    super();
    // hydrate synchronously-ish: load persisted token on construction
    chrome.storage.local.get(AUTH_KEY).then((r) => {
      const a = r[AUTH_KEY];
      if (a?.token) this.save(a.token, a.record);
    });
  }
  save(token, record) {
    super.save(token, record);
    chrome.storage.local.set({ [AUTH_KEY]: { token, record } });
  }
  clear() {
    super.clear();
    chrome.storage.local.remove(AUTH_KEY);
  }
}

export const PB_URL = "https://pb.yourdomain.com";
export const pb = new PocketBase(PB_URL, new ChromeAuthStore());

export async function pbLogin(email, password) {
  return pb.collection("users").authWithPassword(email, password);
}
export function pbLogout() {
  pb.authStore.clear();
}
export function pbIsAuthed() {
  return pb.authStore.isValid;
}
```

- **Login UI** (`LibraryAuth.jsx`): shown at the top of the Library tab when
  `!pbIsAuthed()`. Email + password + "Sign in". On success it disappears and hydration
  runs. A small "Signed in as … · Sign out" line when authed.
- Because the store persists, and PocketBase auth tokens are long-lived (and refreshable via
  `pb.collection('users').authRefresh()` on startup), you log in essentially once per device.
- The token lives in `chrome.storage.local` (not `sync`) — it should not roam to other
  machines automatically; each device logs in once.

---

## 10. Write-through sync + retry queue

`putTranscript` stays the single write funnel. It writes local first (so the UI is instant
and offline-safe), then pushes to PB. On failure it enqueues for retry so a server outage
never loses a transcript.

```js
// background.js (sketch)
import { pb, pbIsAuthed } from "./lib/pb.js";

const SYNC_QUEUE_KEY = "pb_sync_queue"; // array of records pending upsert

async function pbUpsert(rec) {
  // rec keyed by (owner, video_id) via the unique index → find-then-update or create
  const owner = pb.authStore.record?.id;
  if (!owner) throw new Error("not authed");
  const data = { ...rec, owner };
  const existing = await pb
    .collection("transcripts")
    .getFirstListItem(pb.filter("owner = {:o} && video_id = {:v}", { o: owner, v: rec.video_id }))
    .catch(() => null);
  if (existing) return pb.collection("transcripts").update(existing.id, data);
  return pb.collection("transcripts").create(data);
}

async function pbUpsertQueued(rec) {
  if (!pbIsAuthed()) return enqueue(rec); // not logged in yet → hold locally
  try {
    await pbUpsert(rec);
  } catch {
    await enqueue(rec); // offline / server down → retry later
  }
}

async function enqueue(rec) {
  const q = (await chrome.storage.local.get(SYNC_QUEUE_KEY))[SYNC_QUEUE_KEY] || [];
  // de-dup by video_id: keep only the latest patch per video
  const next = q.filter((r) => r.video_id !== rec.video_id).concat(rec);
  await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: next });
}

async function flushQueue() {
  if (!pbIsAuthed()) return;
  let q = (await chrome.storage.local.get(SYNC_QUEUE_KEY))[SYNC_QUEUE_KEY] || [];
  const kept = [];
  for (const rec of q) {
    try { await pbUpsert(rec); } catch { kept.push(rec); }
  }
  await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: kept });
}
```

`putTranscript` gets one added line after the local write:

```js
// after: await chrome.storage.local.set({ [TRANSCRIPTS_KEY]: all });
pbUpsertQueued(toPbRecord(all[videoId])).catch(() => {}); // fire-and-forget
return all[videoId];
```

**Flush triggers:** on SW startup, after login, and on a light alarm (`chrome.alarms`, e.g.
every few minutes) so queued items drain when connectivity returns. (SWs are ephemeral;
`chrome.alarms` survives termination, a `setInterval` does not.)

**Deletes/saves:** deleting a transcript locally (`patchMap(TKEY, id, null)`) and toggling
`saved` must also reach PB. Route those through a `FBW_PB_DELETE` / `FBW_PB_SAVE` message to
the background, or (simpler) have the background diff on hydration. Cleanest: add tiny
message handlers so the panel's existing `patchMap` also notifies the background, which does
the PB update + enqueues on failure.

**Cap change:** with a real DB behind it, drop the local `TRANSCRIPTS_CAP = 20` hard delete
(or raise it to, say, 200 as a local-cache window). The DB keeps everything; the local
mirror keeps a recent slice, and "load more" pages older rows from PB (§11).

---

## 11. Startup hydration + reads

On SW start and when the Library tab opens, pull the owner's transcripts and merge into the
local mirror. Panels keep reading `chrome.storage` + `storage.onChanged` — unchanged.

```js
async function pbHydrate() {
  if (!pbIsAuthed()) return;
  const owner = pb.authStore.record?.id;
  const rows = await pb.collection("transcripts").getFullList({
    filter: pb.filter("owner = {:o}", { o: owner }),
    sort: "-captured_at",
    // for large libraries, use getList(page, perPage) + "load more" instead of getFullList
  });
  const all = (await chrome.storage.local.get(TRANSCRIPTS_KEY))[TRANSCRIPTS_KEY] || {};
  for (const row of rows) {
    const local = all[row.video_id];
    // newest updated wins (local eager "running" card vs server "done")
    if (!local || (row.captured_at || 0) >= (local.updatedAt || 0)) {
      all[row.video_id] = fromPbRecord(row); // includes thumb URL resolution (§12)
    }
  }
  await chrome.storage.local.set({ [TRANSCRIPTS_KEY]: all });
}
```

**Conflict rule:** last-writer-wins by `updatedAt`/`captured_at`. Adequate for a
single-user, few-devices scenario (you rarely transcribe the same video on two devices at
once). No CRDT needed.

**Large libraries:** `getFullList` is fine up to a few hundred rows. Beyond that, hydrate the
first page (e.g. 50 newest) for instant paint, then a "load more" in `TranscriptsPanel` calls
a `FBW_PB_PAGE` message → `getList(page, 50)` → append to the mirror.

---

## 12. Thumbnails: file field vs inline base64

Today `thumb` is a base64 JPEG (~12–25 KB) embedded in each record — it was ~78% of a
record's size, which is exactly why the local store was capped at 20.

Two options for PB:

**A. `thumb` as a PocketBase file field (recommended).**

- On upsert, convert the base64 data URL → `Blob` → append to `FormData` as the `thumb`
  file. PB stores the JPEG on disk (or S3) and the record holds just a filename.
- On hydrate, resolve the URL: `pb.files.getURL(row, row.thumb)` → an `https://pb.…/api/files/…`
  URL. Store that URL in the local mirror's `thumb`. The panel's `<img src={it.thumb}>` works
  unchanged.
- Pros: records stay tiny, DB stays fast, thumbnails cached by the browser/CDN. Cons: the
  panel now loads thumbs over the network (fine; they're small and cached), and offline the
  thumb 404s unless still in the local mirror (it usually is, since capture wrote base64
  locally first).

**B. `thumb` as a text field holding the base64 (simplest).**

- Zero conversion; store the base64 string as-is. Works offline trivially (self-contained
  record). Cons: fatter rows, larger DB, slower list queries at scale.

**Recommendation:** **A** for the server record, but **keep the base64 in the local mirror**
so the UI is instant and offline-safe. i.e. local mirror = base64 (as today); PB = file. On
hydrate for records not captured on this device, fall back to the PB file URL. Best of both.

---

## 13. Backfill migration of existing local data

One-time: push whatever is already in `fbw_transcripts` / `fbw_saved` on your main device up
to PB, so nothing is lost.

- Add a `FBW_PB_BACKFILL` action (a button in the Library "signed in as…" row, or auto-run
  once after first successful login, guarded by a `pb_backfilled` flag).
- It reads the full local `fbw_transcripts` map, maps each to a PB record (merging the
  `saved` flag from `fbw_saved`), and runs `pbUpsert` for each (idempotent via the unique
  index — safe to run twice).
- After success, set `pb_backfilled = true` so it doesn't re-run.

```js
async function pbBackfill() {
  const [{ fbw_transcripts = {} }, { fbw_saved = {} }] =
    await Promise.all([
      chrome.storage.local.get("fbw_transcripts"),
      chrome.storage.local.get("fbw_saved"),
    ]);
  const savedIds = new Set(Object.keys(fbw_saved));
  for (const rec of Object.values(fbw_transcripts)) {
    await pbUpsertQueued(toPbRecord({ ...rec, saved: savedIds.has(rec.videoId) }));
  }
  await chrome.storage.local.set({ pb_backfilled: true });
}
```

---

## 14. Manifest / CSP / host permissions

`manifest.config.js` changes:

```js
permissions: [
  "storage", "unlimitedStorage", "activeTab", "sidePanel", "tabs",
  "webRequest", "offscreen", "downloads", "scripting",
  "alarms",                       // NEW — drain the sync queue on a schedule
],
host_permissions: [
  "*://*.facebook.com/*",
  "*://*.instagram.com/*",
  "*://*.tiktok.com/*",
  "*://*.fbcdn.net/*",
  "*://*.cdninstagram.com/*",
  "https://pb.yourdomain.com/*",  // NEW — PocketBase API + files + SSE
],
content_security_policy: {
  // add connect-src so the side-panel page may fetch the PB origin.
  // (host_permissions covers the SW; the extension PAGE also needs connect-src.)
  extension_pages:
    "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'; " +
    "connect-src 'self' https://pb.yourdomain.com https://*.fbcdn.net https://*.cdninstagram.com",
  // img-src for remote thumbnails if using file fields (option A):
  // "img-src 'self' data: blob: https://pb.yourdomain.com;"
},
```

Notes:

- The **background service worker**'s fetches are gated by `host_permissions` — adding the PB
  origin there is enough for SW-side PB calls.
- The **side panel** is an extension page; if it ever calls PB directly (login form, "load
  more"), its page CSP `connect-src` must include the PB origin. Keep all PB I/O in the SW and
  the panel only needs `connect-src` if the login form calls `pbLogin` from the panel context.
  Simplest: panel sends `FBW_PB_LOGIN`/`FBW_PB_PAGE` messages to the SW, which owns `pb`. Then
  only the SW needs network access and the CSP `connect-src` addition is belt-and-suspenders.
- If thumbnails use file fields (option A), add `img-src ... https://pb.yourdomain.com` so
  `<img>` can load them.
- Publishing to the Web Store changes the extension id → update PocketBase CORS with the new
  `chrome-extension://<id>`.

---

## 15. Security notes

- **HTTPS only.** The extension talks to `https://pb.yourdomain.com`; never plain HTTP (mixed
  content + token interception).
- **Owner-scoped rules are the real access control.** Even though it's a single account, set
  the five rules to `@request.auth.id != "" && owner = @request.auth.id` so the API can't be
  read/written by an unauthenticated caller. Do **not** leave rules as empty string (public).
- **Superuser vs app account.** Log the extension in as a normal `users` record, never the
  superuser. The superuser is for the dashboard only.
- **Token at rest.** The auth token sits in `chrome.storage.local` — readable by the
  extension only, not by web pages. Acceptable for a personal tool. `authRefresh()` on startup
  keeps it valid; `pbLogout()` clears it.
- **CORS is not auth.** Allowing the extension origin only stops browsers from making cross-
  origin calls; the rules do the actual gating. Keep the allow-list tight (your extension id,
  your website if any).
- **Rate/secret hygiene.** No secrets ship in the extension beyond the PB base URL (public by
  nature). The password is entered by you at login, never bundled.
- **Backups.** Enable PocketBase backups (or volume snapshots). The `pb_data` dir is the whole
  library.

---

## 16. Phasing + effort estimate

**Phase 0 — Server up (yours, ~1–2h, mostly clicks).**
Dockerfile → EasyPanel app → persistent volume at `/pb/pb_data` → domain + TLS → superuser →
one app account → `transcripts` collection + unique index + 5 rules → CORS allow extension id.
Acceptance: you can create/read a test record from the dashboard; `curl` the API with the
account token returns it.

**Phase 1 — Read-only hydration (mine, ~½ day).**
`lib/pb.js` + `ChromeAuthStore` + login UI + `pbHydrate()` on SW start / panel open. No writes
yet. Acceptance: a record created in the dashboard appears in the Library after reload.

**Phase 2 — Write-through + queue (mine, ~½ day).**
`putTranscript` → `pbUpsertQueued`, `chrome.alarms` flush, delete/save propagation, drop the
20-cap. Acceptance: transcribe a video → row appears in PB; kill the server → transcribe →
row queues locally → server back → row syncs.

**Phase 3 — Backfill + thumbnails-as-files (mine, ~½ day).**
`pbBackfill()` one-shot; convert thumb to file field + resolve URLs on hydrate. Acceptance:
existing local library shows up in PB; new records store thumbs as files; panel thumbnails
render from PB URLs.

**Total mine:** ~1.5 days. **Yours:** ~1–2h of VPS/EasyPanel/DNS.

---

## 17. Task checklist

**Server (you):**

- [ ] Dockerfile (pin `PB_VERSION`) in a repo/subfolder.
- [ ] EasyPanel app, build path set, deploy.
- [ ] Persistent volume mounted at `/pb/pb_data`.
- [ ] Domain `pb.yourdomain.com` + TLS, port → 8090.
- [ ] Superuser created; one `users` account created for the extension.
- [ ] `transcripts` collection with fields (§6.2).
- [ ] Unique index `(owner, video_id)`.
- [ ] Five rules = `@request.auth.id != "" && owner = @request.auth.id`.
- [ ] CORS allow `chrome-extension://cmaidhikebdolakdmipclahbokbokflg`.
- [ ] Backups enabled (built-in or volume snapshot).

**Extension (me):**

- [ ] `npm i pocketbase`.
- [ ] `src/lib/pb.js` — client + `ChromeAuthStore` + `pbLogin/Logout/IsAuthed/Upsert/Hydrate`.
- [ ] `to/fromPbRecord()` mappers (incl. thumb base64 ↔ file).
- [ ] `LibraryAuth.jsx` login/logout UI in the Library tab.
- [ ] `putTranscript` write-through + `pb_sync_queue` + `chrome.alarms` flush.
- [ ] Delete/save propagation messages (`FBW_PB_DELETE`, `FBW_PB_SAVE`).
- [ ] `pbHydrate()` on SW start + panel open; "load more" paging for big libraries.
- [ ] `pbBackfill()` one-shot + `pb_backfilled` guard.
- [ ] Manifest: `alarms` permission, PB `host_permissions`, CSP `connect-src`/`img-src`.
- [ ] Drop/raise `TRANSCRIPTS_CAP`.
- [ ] Version bump + CHANGELOG entry.

**Config handshake (both):** you give me the final `PB_URL` and confirm the account exists;
I wire it into `lib/pb.js` (or read it from an options field so it isn't hardcoded).

---

## 18. Open questions / future

- **PB URL config:** hardcode in `lib/pb.js`, or expose an options field so you can point at
  a different instance without a rebuild? (Options field is cheap; recommend it.)
- **`fbw_saved` shape:** collapse into a `saved` bool on `transcripts` (recommended — one
  collection), or keep a parallel `saved` collection? A saved video that was never
  transcribed has no transcript row — if you save non-transcribed videos, either allow
  transcript rows with `status` unset, or keep `saved` as its own tiny collection. Decide
  from how `fbw_saved` is actually populated (auto-capture favorites can save without a
  transcript).
- **Run history / dedup sync:** add `run_history` / `seen_ids` collections later if you want
  those to roam across devices.
- **Realtime:** add `pb.collection('transcripts').subscribe('*', …)` in the open side panel
  for live cross-device updates. Deferred (SSE is awkward from the ephemeral SW; fine in the
  panel while open).
- **Multi-user:** if you ever distribute, flip on signup + email verification and the
  owner-scoped rules already isolate users — the schema doesn't change.

---

## 19. Reference snippets

### 19.1 Record mappers

```js
// local record (chrome.storage) -> PB record
function toPbRecord(r) {
  return {
    video_id: r.videoId,
    platform: r.platform || "facebook",
    author_name: r.author?.name || "",
    author_url: r.author?.url || "",
    caption: r.caption || "",
    counts: r.counts || null,
    source_url: r.sourceUrl || "",
    text: r.text || "",
    chunks: r.chunks || [],
    status: r.status || "done",
    error: r.error || "",
    saved: !!r.saved,
    captured_at: r.updatedAt || Date.now(),
    // thumb handled separately (FormData file) — see §12
  };
}

// PB record -> local record (chrome.storage mirror)
function fromPbRecord(row) {
  return {
    videoId: row.video_id,
    platform: row.platform,
    author: row.author_name ? { name: row.author_name, url: row.author_url || null } : null,
    caption: row.caption || null,
    counts: row.counts || null,
    sourceUrl: row.source_url || null,
    text: row.text || "",
    chunks: row.chunks || [],
    status: row.status || "done",
    error: row.error || null,
    saved: !!row.saved,
    updatedAt: row.captured_at || Date.parse(row.updated) || Date.now(),
    thumb: row.thumb ? pb.files.getURL(row, row.thumb) : null, // file-field option
  };
}
```

### 19.2 Thumb base64 → file on upsert

```js
function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(head)?.[1] || "image/jpeg";
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

async function pbUpsertWithThumb(rec, thumbDataUrl) {
  const owner = pb.authStore.record?.id;
  const fd = new FormData();
  const data = { ...toPbRecord(rec), owner };
  for (const [k, v] of Object.entries(data))
    fd.set(k, typeof v === "object" && v !== null ? JSON.stringify(v) : v ?? "");
  if (thumbDataUrl?.startsWith("data:"))
    fd.set("thumb", dataUrlToBlob(thumbDataUrl), `${rec.videoId}.jpg`);
  const existing = await pb.collection("transcripts")
    .getFirstListItem(pb.filter("owner = {:o} && video_id = {:v}", { o: owner, v: rec.videoId }))
    .catch(() => null);
  return existing
    ? pb.collection("transcripts").update(existing.id, fd)
    : pb.collection("transcripts").create(fd);
}
```

### 19.3 Panel ↔ background messages (new)

```
FBW_PB_LOGIN    { email, password }        -> { ok, error }
FBW_PB_LOGOUT   {}                          -> { ok }
FBW_PB_STATUS   {}                          -> { authed, email, queued }
FBW_PB_PAGE     { page }                    -> { rows, hasMore }   // "load more"
FBW_PB_DELETE   { videoId }                 -> { ok }
FBW_PB_SAVE     { videoId, saved }          -> { ok }
FBW_PB_BACKFILL {}                          -> { ok, count }
```

All handled in `background.js` where `pb` lives; the panel never imports the SDK.

### 19.4 Optional PB JS migration (schema as code)

If you prefer schema-as-code over dashboard clicks, drop a file in `pb_migrations/` (served
by the same binary). Sketch:

```js
// pb_migrations/1700000000_transcripts.js
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const c = new Collection({
    name: "transcripts",
    type: "base",
    listRule:   '@request.auth.id != "" && owner = @request.auth.id',
    viewRule:   '@request.auth.id != "" && owner = @request.auth.id',
    createRule: '@request.auth.id != "" && owner = @request.auth.id',
    updateRule: '@request.auth.id != "" && owner = @request.auth.id',
    deleteRule: '@request.auth.id != "" && owner = @request.auth.id',
    fields: [
      { name: "owner", type: "relation", required: true,
        options: { collectionId: users.id, maxSelect: 1, cascadeDelete: true } },
      { name: "video_id",   type: "text",   required: true },
      { name: "platform",   type: "text" },
      { name: "author_name",type: "text" },
      { name: "author_url", type: "text" },
      { name: "caption",    type: "text" },
      { name: "counts",     type: "json" },
      { name: "source_url", type: "text" },
      { name: "text",       type: "text" },
      { name: "chunks",     type: "json" },
      { name: "thumb",      type: "file", options: { maxSelect: 1, maxSize: 5242880 } },
      { name: "status",     type: "text" },
      { name: "error",      type: "text" },
      { name: "saved",      type: "bool" },
      { name: "captured_at",type: "number" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_owner_video ON transcripts (owner, video_id)",
    ],
  });
  app.save(c);
}, (app) => {
  const c = app.findCollectionByNameOrId("transcripts");
  app.delete(c);
});
```

> Field/option names track PocketBase ~v0.22. Verify against the exact `PB_VERSION` you pin —
> the collection API shifted around v0.23; adjust `fields`/`options` if you run a newer build.

---

*End of plan. Nothing here is built yet. When PocketBase is reachable at your domain (or you
want the Dockerfile + schema handed over first), say go and I'll start on Phase 1.*
