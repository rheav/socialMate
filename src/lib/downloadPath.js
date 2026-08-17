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

export const DOWNLOAD_ROOT = "social-mate";

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
  const parts = [DOWNLOAD_ROOT];
  const bucket = bucketFor(kind, filename);
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
  if (segs[0] === DOWNLOAD_ROOT) segs.shift();
  return [DOWNLOAD_ROOT, ...(segs.length ? segs : [FALLBACK_NAME])].join("/");
}

// A pin, an IG carousel child or a story can be either an image or a video, so the
// bucket must follow the media actually being saved, not the platform's usual
// output. The libs already resolve the extension before naming the file, so that is
// the cheapest honest signal of what the bytes are.
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "m4v", "mkv"]);

export function kindFromExt(ext) {
  return VIDEO_EXTS.has(String(ext || "").toLowerCase()) ? "video" : "image";
}
