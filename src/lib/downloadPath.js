// ---------------------------------------------------------------------------
// The single owner of every download path this extension produces.
//
// Before this module each call site invented its own folder: "socialmate-comments/",
// "socialmate-fotos/", "socialmate-runs/", "socialMate-thumbs/" (yes, a different
// capital M) — and most downloads had no folder at all, so photos, reels, stories
// and muxed videos landed loose in ~/Downloads. Four spellings for four folders and
// a dozen files spilled into the Downloads root: "fica bagunçado".
//
// Now every filename that reaches chrome.downloads.download is built here, so the
// tree can never drift apart again:
//
//   social-mate/
//     facebook/   videos | fotos | miniaturas | comentarios | transcricoes
//     instagram/  videos | imagens | miniaturas | transcricoes
//     tiktok/     videos | imagens | miniaturas | comentarios | transcricoes
//     pinterest/  videos | imagens
//     sessoes/    (run logs — not tied to a platform)
//
// Folder names are pt-BR because the user browses them in Finder and the whole UI
// is pt-BR. The map KEYS stay the internal English ids (the platform ids from
// lib/platforms.jsx, plus the media kinds), so nothing else in the codebase changes.
// ---------------------------------------------------------------------------

// The name-part scrubber lives in shared/ because the content scripts need it too
// and cannot import. Re-exported here so every existing caller is unchanged.
import { sanitizeFilenamePart } from "./shared/filenames.js";
export { sanitizeFilenamePart };

export const DOWNLOAD_ROOT = "social-mate";

// Only real platforms live here. There used to be a SESSIONS pseudo-platform
// mapping to "sessoes/" for the per-run telemetry JSON that got downloaded after
// every run; that feature was removed in 0.68.0, so the folder went with it.
const PLATFORM_DIRS = {
  facebook: "facebook",
  instagram: "instagram",
  tiktok: "tiktok",
  pinterest: "pinterest",
};

// Facebook says "fotos" where the others say "imagens" — that is the word Facebook
// itself uses in pt-BR, and the user recognises it. "miniaturas" holds cover-only
// downloads (the "baixar miniatura" buttons and the reels-grid thumb dump); they are
// kept apart from the full-size media so a pile of covers never buries the real files.
const KIND_DIRS = {
  facebook: { video: "videos", image: "fotos", thumb: "miniaturas", comments: "comentarios", transcript: "transcricoes" },
  instagram: { video: "videos", image: "imagens", thumb: "miniaturas", transcript: "transcricoes" },
  tiktok: { video: "videos", image: "imagens", thumb: "miniaturas", comments: "comentarios", transcript: "transcricoes" },
  pinterest: { video: "videos", image: "imagens" },
};

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

/**
 * Build the download path for one file.
 *
 *   downloadPath("instagram", "video", "ig-ivy-X1.mp4")
 *     -> "social-mate/instagram/videos/ig-ivy-X1.mp4"
 *   downloadPath("facebook", "comments", "fb-123-2026-07-26.json")
 *     -> "social-mate/facebook/comentarios/fb-123-2026-07-26.json"
 *
 * `filename` is a path relative to the kind folder — usually a bare name, but it may
 * carry sub-folders (the reels-grid thumb dump groups by page author). Each segment
 * is scrubbed on its own, so an author literally named "../../etc" lands as a segment
 * inside the tree instead of escaping it.
 *
 * The result is always relative to ~/Downloads: it never starts with "/", never has a
 * ".." component and never a drive letter. chrome.downloads rejects all three, and
 * every call site here swallows download errors — a bad path would fail invisibly.
 */
export function downloadPath(platform, kind, filename) {
  const parts = [DOWNLOAD_ROOT];
  const platformDir = PLATFORM_DIRS[platform];
  if (platformDir) parts.push(platformDir);
  const kindDir = platformDir && KIND_DIRS[platform] ? KIND_DIRS[platform][kind] : null;
  if (kindDir) parts.push(kindDir);

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
// sub-folder must follow the media actually being saved, not the platform's usual
// output. The libs already resolve the extension before naming the file, so that is
// the cheapest honest signal of what the bytes are.
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "m4v", "mkv"]);

export function kindFromExt(ext) {
  return VIDEO_EXTS.has(String(ext || "").toLowerCase()) ? "video" : "image";
}

// Canonical filename-part scrubber. This used to be copy-pasted byte-identically into
// fbPhotos / fbReels / igMedia / ttMedia / pinMedia; those now re-export this one so
// there is a single definition. Caps at 40 chars because it is only ever applied to a
// PART of a name (an owner/author), never to the whole file name.
