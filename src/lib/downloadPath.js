// ---------------------------------------------------------------------------
// The single owner of every download path this extension produces.
//
// Before this module each call site invented its own folder: "socialmate-comments/",
// "socialmate-fotos/", "socialmate-runs/", "socialMate-thumbs/" (yes, a different
// capital M) — and most downloads had no folder at all, so photos, reels, stories
// and muxed videos landed loose in ~/Downloads. Four spellings for four folders and
// a dozen files spilled into the Downloads root: "fica bagunçado".
//
// The first fix over-corrected into root → platform → kind: 22 directories, built
// from a platform map plus a per-platform kind map (which is how Facebook ended up
// with "fotos" while everyone else got "imagens"). Both maps were redundant with
// the file name, because every name this extension produces ALREADY says where the
// file came from and what it is:
//
//   fb-astravale-1234.jpg   ig-ivy-DaBFBcgxZIi.mp4   tt-veloria691-765….mp4
//   tt-veloria691-765…-thumb.jpg   ig-tag_cardreading-2026-08-16.xlsx
//
// So "social-mate/tiktok/videos/tt-…-765….mp4" said "tiktok" twice and "video"
// twice. Only ONE thing still earns a folder: keeping bulk junk away from the file
// you went there for. A cover dump is 50-200 thumbnails and JSON/XLSX are data, not
// media. That is three buckets, and nothing else:
//
//   social-mate/
//     videos/    every .mp4, whatever platform it came from
//     imagens/   photos AND covers (a cover is already named "…-thumb.jpg")
//     dados/     comment JSON, spreadsheets, transcripts, album ZIPs
//
// Folder names are pt-BR because the user browses them in Finder and the whole UI
// is pt-BR. The KEYS stay the internal English media kinds, so no call site has to
// learn a new vocabulary — they pass the same `kind` they always did.
// ---------------------------------------------------------------------------

// The name-part scrubber lives in shared/ because the content scripts need it too
// and cannot import. Re-exported here so every existing caller is unchanged.
import { sanitizeFilenamePart } from "./shared/filenames.js";
export { sanitizeFilenamePart };

// The DEFAULT folder. It is a default, not a law: since 0.99.0 the folder and the
// bucketing are settings (Opções → Downloads), because "sem folders e mais
// folders" is a legitimate way to want your files — a flat folder sorts by name,
// and every name this extension produces starts with the creator's handle.
//
// CHROME'S LIMIT, which the setting cannot lift: chrome.downloads.download only
// accepts a path RELATIVE to the browser's own download directory. An absolute
// path ("/Users/…", "D:\\") is rejected outright, and so is any "..". So an empty
// folder setting means "straight into the browser's download directory", and
// pointing that somewhere else is a browser setting (chrome://settings/downloads),
// not something an extension can do.
export const DOWNLOAD_ROOT = "social-mate";

export const DL_PREFS_KEY = "fbw_dl";

export const DEFAULT_DL_PREFS = { folder: DOWNLOAD_ROOT, flat: false };

/**
 * Coerce whatever is in storage into a usable pair. A folder may be nested
 * ("pesquisa/instagram"); each segment is scrubbed on its own, and an absolute
 * path or a ".." is reduced to its harmless parts rather than rejected — a
 * setting that silently downloads nothing is worse than one that lands somewhere
 * sane.
 */
export function normalizeDlPrefs(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    folder: folderSegments(r.folder === undefined ? DEFAULT_DL_PREFS.folder : r.folder).join("/"),
    flat: !!r.flat,
  };
}

export function folderSegments(folder) {
  return String(folder == null ? "" : folder)
    .replace(/^[A-Za-z]:/, "") // a drive letter would make it absolute on Windows
    .split(/[\\/]+/)
    .map(safeSegment)
    .filter(Boolean);
}

// The live copy every call site reads. downloadPath() is called synchronously from
// panels, libs and the service worker, while chrome.storage is async — so the
// prefs are CACHED here and primed once per context (see initDownloadPrefs).
let PREFS = { ...DEFAULT_DL_PREFS };

/** Replace the cached prefs. Exported for tests and for the storage listener. */
export function setDownloadPrefs(raw) {
  PREFS = normalizeDlPrefs(raw);
  return PREFS;
}

export function getDownloadPrefs() {
  return PREFS;
}

/**
 * Prime the cache in this context and keep it live. Safe to call more than once,
 * and a no-op outside an extension context (the unit tests).
 *
 * Both the panel and the service worker call it: the panel downloads its own
 * spreadsheets, transcripts and ZIPs directly (it is the only context that can
 * mint a blob URL), so the worker is NOT the single gate it once was.
 */
export function initDownloadPrefs() {
  const local = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  if (!local) return;
  try {
    local.get(DL_PREFS_KEY, (r) => setDownloadPrefs(r && r[DL_PREFS_KEY]));
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c[DL_PREFS_KEY]) setDownloadPrefs(c[DL_PREFS_KEY].newValue);
    });
  } catch {
    // A context without storage access keeps the defaults rather than throwing
    // inside a download call.
  }
}

// Media kind -> bucket. `thumb` deliberately shares a bucket with `image`: the
// covers are named "…-thumb.jpg" already, so a folder to say the same thing again
// only adds a directory to click through.
const BUCKETS = {
  video: "videos",
  image: "imagens",
  thumb: "imagens",
  comments: "dados",
  transcript: "dados",
  sheet: "dados",
};

// Extensions that are data whatever the caller called them. This is not pedantry:
// fbPhotos builds its album archive through the `image` kind, so before this the
// ZIP was filed with the photos. The extension is the honest signal about what the
// bytes are, and it overrules a kind that would misfile them.
const DATA_EXTS = new Set(["json", "xlsx", "csv", "txt", "vtt", "srt", "zip"]);

// The bucket names as they appear in a path, so underDownloadRoot can recognise a
// bucket a caller already chose instead of guessing it back from the extension.
const BUCKET_NAMES = new Set(Object.values(BUCKETS));

// Used when a caller hands us nothing usable. A nameless download is a bug, but a
// stable name keeps it visible in the folder instead of failing silently.
const FALLBACK_NAME = "arquivo";

// Scrub ONE path segment. Deliberately not sanitizeFilenamePart(): that one caps at
// 40 chars, which on a file name would eat the extension ("ig-…-X1.mp4" -> "ig-…-X"),
// and Chrome would then save an extensionless file.
//
// The rules that matter for chrome.downloads: no separators (they would create
// folders the caller never asked for), no "." / ".." components (Chrome rejects the
// whole download), no control characters, and nothing Windows refuses — the ZIPs and
// JSONs get shared around.
function safeSegment(s) {
  return String(s == null ? "" : s)
    .replace(/[\\/]+/g, "_") // a slash inside a segment is data, not structure
    .replace(/[\u0000-\u001f<>:"|?*]+/g, "_") // control chars + Windows-illegal
    .replace(/^\.+/, "") // kills ".", "..", and accidental hidden files
    .replace(/[. ]+$/, "") // Windows drops trailing dots/spaces silently
    .trim()
    .slice(0, 120);
}

const extOf = (name) => {
  const m = String(name == null ? "" : name).match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : "";
};

/** Which of the three buckets a file belongs in, or null to sit at the root. */
function bucketFor(kind, filename) {
  if (DATA_EXTS.has(extOf(filename))) return "dados";
  return BUCKETS[kind] || null;
}

/**
 * Build the download path for one file.
 *
 *   downloadPath("video", "ig-ivy-X1.mp4")      -> "social-mate/videos/ig-ivy-X1.mp4"
 *   downloadPath("comments", "fb-123-x.json")   -> "social-mate/dados/fb-123-x.json"
 *   downloadPath("thumb", "tt-a-1-thumb.jpg")   -> "social-mate/imagens/tt-a-1-thumb.jpg"
 *
 * `filename` is a path relative to the bucket — usually a bare name, but it may
 * carry sub-folders. Each segment is scrubbed on its own, so an author literally
 * named "../../etc" lands as a segment inside the tree instead of escaping it.
 *
 * The result is always relative to ~/Downloads: it never starts with "/", never has a
 * ".." component and never a drive letter. chrome.downloads rejects all three, and
 * every call site here swallows download errors — a bad path would fail invisibly.
 */
export function downloadPath(kind, filename) {
  const parts = folderSegments(PREFS.folder);
  // `flat` is the whole point of the setting: one folder, sorted by name, and
  // every name starts with the creator's handle.
  const bucket = PREFS.flat ? null : bucketFor(kind, filename);
  if (bucket) parts.push(bucket);

  const tail = String(filename == null ? "" : filename)
    .split(/[\\/]+/)
    .map(safeSegment)
    .filter(Boolean);
  parts.push(...(tail.length ? tail : [FALLBACK_NAME]));
  return parts.join("/");
}

/**
 * Last line of defence, used by background.js — the only context that actually calls
 * chrome.downloads, and the one that receives filenames over messages from panels and
 * content scripts. A caller that forgot downloadPath() would otherwise drop a file
 * straight into ~/Downloads, which is exactly the mess this module exists to end.
 *
 * A path already under social-mate/ comes back byte-identical (so nothing that is
 * already correct is rewritten); anything else is scrubbed and re-rooted.
 */
export function underDownloadRoot(path) {
  const segs = String(path == null ? "" : path)
    .replace(/^[A-Za-z]:/, "") // a drive letter would make it absolute on Windows
    .split(/[\\/]+/)
    .map(safeSegment)
    .filter(Boolean);
  const name = segs.pop() || FALLBACK_NAME;
  // Rebuild rather than patch the prefix. A path that arrives here was built under
  // WHATEVER folder was configured when its caller ran — a different folder, or a
  // bucket that `flat` has since switched off. Keeping only the file name (and the
  // bucket the path itself already chose) makes this idempotent under the current
  // prefs, which is what "last line of defence" has to mean once the root moves.
  const prior = segs.length && BUCKET_NAMES.has(segs[segs.length - 1]) ? segs[segs.length - 1] : null;
  const parts = folderSegments(PREFS.folder);
  const bucket = PREFS.flat ? null : prior || bucketFor(null, name);
  if (bucket) parts.push(bucket);
  parts.push(name);
  return parts.join("/");
}

// A pin, an IG carousel child or a story can be either an image or a video, so the
// bucket must follow the media actually being saved, not the platform's usual
// output. The libs already resolve the extension before naming the file, so that is
// the cheapest honest signal of what the bytes are.
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "m4v", "mkv"]);

export function kindFromExt(ext) {
  return VIDEO_EXTS.has(String(ext || "").toLowerCase()) ? "video" : "image";
}
