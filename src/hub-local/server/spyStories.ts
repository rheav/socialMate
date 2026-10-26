import type { MiniDatabase } from "./db.js";
import { webUrl } from "./spy.js";
import { dayStart, daysBefore } from "./spyTopPosts.js";

// Stories swipe file: the stories of the tracked Instagram profiles, captured by
// the extension from the stories page, kept for a configurable number of days.
// Metadata lives in spy_stories; the media and a small poster are Blobs in
// IndexedDB (local build; the hub keeps files under DATA_DIR/stories), reached
// through a MediaStore: `media_path`/`poster_path` hold the store's key. The Spy's own settings (passes per day, days kept) live in
// spy_settings as JSON, one row per key.
// Design: docs/superpowers/specs/2026-10-19-stories-swipe-file-design.md

export interface StoriesSettings {
  /** How many times a day the extension visits the tracked profiles (1–4). */
  passesPerDay: number;
  /** For how many days a story stays, counted from its publication (1–30). */
  keepDays: number;
  /** Every morning, the report of yesterday's stories, read on AGY (hub 0.40). */
  dailyReport: boolean;
}

export const STORIES_DEFAULTS: StoriesSettings = { passesPerDay: 2, keepDays: 7, dailyReport: true };

const SETTINGS_KEY = "stories";
const LIMITS: Record<"passesPerDay" | "keepDays", [number, number]> = { passesPerDay: [1, 4], keepDays: [1, 30] };

export function readStoriesSettings(database: MiniDatabase): StoriesSettings {
  const row = database.db.prepare("SELECT value FROM spy_settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
  let saved: Partial<StoriesSettings> = {};
  try {
    saved = row ? (JSON.parse(row.value) as Partial<StoriesSettings>) : {};
  } catch {
    saved = {};
  }
  return { ...STORIES_DEFAULTS, ...saved };
}

/** Integers within the limits and a boolean switch only; anything else is `invalid_settings`. */
export function updateStoriesSettings(database: MiniDatabase, patch: Partial<StoriesSettings>, now = Date.now()): StoriesSettings {
  const next = readStoriesSettings(database);
  if ("dailyReport" in patch) {
    if (typeof patch.dailyReport !== "boolean") throw new Error("invalid_settings");
    next.dailyReport = patch.dailyReport;
  }
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    if (!(key in patch)) continue;
    const value = patch[key];
    const [min, max] = LIMITS[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error("invalid_settings");
    next[key] = value;
  }
  database.db.prepare(`
    INSERT INTO spy_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(SETTINGS_KEY, JSON.stringify(next), now);
  return next;
}

// ---- ingestion ----

export type StoryMime = "video/mp4" | "image/jpeg";

/** One story as the extension reduces it (spec §7.4); times in ms. */
export interface StoryInput {
  id: string;
  reelId?: string | null;
  mediaType: 1 | 2;
  takenAt: number;
  expiringAt: number;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  caption?: string | null;
  links?: { url: string; text?: string }[];
  music?: { title: string; artist?: string } | null;
  mentions?: string[];
  aiLabel?: boolean;
  mediaMime: StoryMime;
}

export interface IngestStoriesResult {
  added: number;
  known: number;
  unknown: number;
  invalid: number;
}

const ID_RE = /^\d{1,30}$/;
const MIMES = new Set<string>(["video/mp4", "image/jpeg"]);
/** 2001-09-09 in ms; anything below is a timestamp in seconds. */
const MS_FLOOR = 1_000_000_000_000;
/** A `.part` younger than this may be an upload still streaming in. */
const PART_GRACE_MS = 10 * 60_000;

const optionalInt = (v: unknown): number | null | undefined =>
  v == null ? null : Number.isFinite(v as number) ? Math.round(v as number) : undefined;

/** The row to store, or null when the shape is wrong. */
function parseStory(raw: unknown): (StoryInput & { profileId: string }) | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.profileId !== "string" || typeof r.id !== "string" || !ID_RE.test(r.id)) return null;
  if (r.mediaType !== 1 && r.mediaType !== 2) return null;
  // Milliseconds, like every other clock in the hub: a value in seconds would
  // read as 1970 and be pruned on arrival, silently, pass after pass.
  if (typeof r.takenAt !== "number" || typeof r.expiringAt !== "number" || !(r.takenAt < r.expiringAt)) return null;
  if (r.takenAt < MS_FLOOR) return null;
  if (typeof r.mediaMime !== "string" || !MIMES.has(r.mediaMime)) return null;
  const durationMs = optionalInt(r.durationMs);
  const width = optionalInt(r.width);
  const height = optionalInt(r.height);
  if (durationMs === undefined || width === undefined || height === undefined) return null;
  const links: { url: string; text?: string }[] = [];
  for (const link of Array.isArray(r.links) ? r.links : []) {
    const url = webUrl((link as { url?: unknown })?.url);
    if (!url) continue;
    const text = (link as { text?: unknown })?.text;
    links.push(typeof text === "string" && text ? { url, text: text.slice(0, 200) } : { url });
  }
  const music = r.music && typeof r.music === "object" && typeof (r.music as { title?: unknown }).title === "string"
    ? { title: String((r.music as { title: string }).title).slice(0, 200),
      ...(typeof (r.music as { artist?: unknown }).artist === "string" ? { artist: String((r.music as { artist: string }).artist).slice(0, 200) } : {}) }
    : null;
  const mentions = (Array.isArray(r.mentions) ? r.mentions : []).filter((m): m is string => typeof m === "string").slice(0, 50);
  return {
    profileId: r.profileId,
    id: r.id,
    reelId: typeof r.reelId === "string" ? r.reelId : null,
    mediaType: r.mediaType,
    takenAt: Math.round(r.takenAt),
    expiringAt: Math.round(r.expiringAt),
    durationMs,
    width,
    height,
    caption: typeof r.caption === "string" ? r.caption.slice(0, 2200) : null,
    links,
    music,
    mentions,
    aiLabel: r.aiLabel === true,
    mediaMime: r.mediaMime as StoryMime,
  };
}

/** Metadata first: the row waits (`ready_at` NULL) for its media and poster. */
export function ingestStories(database: MiniDatabase, items: unknown[], now = Date.now()): IngestStoriesResult {
  const result: IngestStoriesResult = { added: 0, known: 0, unknown: 0, invalid: 0 };
  const active = database.db.prepare("SELECT 1 FROM spy_profiles WHERE id = ? AND removed_at IS NULL");
  const exists = database.db.prepare("SELECT 1 FROM spy_stories WHERE id = ?");
  const insert = database.db.prepare(`
    INSERT INTO spy_stories (id, profile_id, reel_id, media_type, taken_at, expiring_at, duration_ms, width, height, caption,
      links, music, mentions, ai_label, media_mime, captured_at)
    VALUES (@id, @profileId, @reelId, @mediaType, @takenAt, @expiringAt, @durationMs, @width, @height, @caption,
      @links, @music, @mentions, @aiLabel, @mediaMime, @capturedAt)
  `);
  for (const raw of items) {
    const s = parseStory(raw);
    if (!s) { result.invalid += 1; continue; }
    if (!active.get(s.profileId)) { result.unknown += 1; continue; }
    if (exists.get(s.id)) { result.known += 1; continue; }
    insert.run({
      ...s,
      links: JSON.stringify(s.links),
      music: s.music ? JSON.stringify(s.music) : null,
      mentions: JSON.stringify(s.mentions),
      aiLabel: s.aiLabel ? 1 : 0,
      capturedAt: now,
    });
    result.added += 1;
  }
  return result;
}

// ---- files ----

/**
 * Local build: where the media and posters live (the hub: a directory). Reads
 * and writes are async (IndexedDB); `remove` only notes the keys, and the
 * router deletes them after the request that dropped their rows is saved, so the
 * synchronous SQL code here keeps its shape.
 */
export interface MediaStore {
  /** The key a story's media or poster is stored under. */
  key(id: string, kind: "media" | "poster"): string;
  remove(keys: string[]): void;
  put?(key: string, blob: Blob): Promise<void>;
  size?(key: string): Promise<number | null>;
}

/** The store of the database (the hub: the directory next to the database file). */
export function storiesDirForDb(database: MiniDatabase): MediaStore {
  return database.media;
}

export class StoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const STORY_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const STORY_POSTER_MAX_BYTES = 200 * 1024;
const KEY_RE = /^[a-z0-9._]{1,64}$/;

type StoryFileRow = {
  id: string; platform: string; key: string; media_mime: string; media_path: string | null; media_bytes: number | null;
  poster_path: string | null; ready_at: number | null;
};

function storyFileRow(database: MiniDatabase, id: string): StoryFileRow | undefined {
  return database.db.prepare(`
    SELECT s.id, p.platform, p.key, s.media_mime, s.media_path, s.media_bytes, s.poster_path, s.ready_at
    FROM spy_stories s JOIN spy_profiles p ON p.id = s.profile_id
    WHERE s.id = ?
  `).get(id) as StoryFileRow | undefined;
}

/**
 * The media or the poster of one story (local build: a Blob, kept in the
 * MediaStore; the hub streams it to a file). The row must exist (the extension
 * sends the metadata first). A repeated upload of a file already there answers
 * with that file instead of writing again.
 */
export async function acceptStoryBlob(
  database: MiniDatabase,
  dir: MediaStore,
  id: string,
  kind: "media" | "poster",
  blob: Blob,
  { contentType }: { contentType: string },
): Promise<{ id: string; bytes: number; ready: boolean }> {
  if (!ID_RE.test(id)) throw new StoryError(400, "bad_id");
  const row = storyFileRow(database, id);
  if (!row) throw new StoryError(404, "unknown_story");
  if (!KEY_RE.test(row.key)) throw new StoryError(400, "bad_key");
  const type = contentType.split(";")[0].trim().toLowerCase();
  const expected = kind === "media" ? row.media_mime : "image/webp";
  if (type !== expected) throw new StoryError(415, "unsupported_type");
  const maxBytes = kind === "media" ? STORY_MEDIA_MAX_BYTES : STORY_POSTER_MAX_BYTES;
  if (blob.size > maxBytes) throw new StoryError(413, "media_too_large");

  const stored = kind === "media" ? row.media_path : row.poster_path;
  const storedSize = stored ? await dir.size?.(stored) : null;
  if (stored && storedSize != null) {
    return { id, bytes: kind === "media" ? row.media_bytes ?? 0 : storedSize, ready: row.ready_at != null };
  }

  const relative = dir.key(id, kind);
  try {
    await dir.put!(relative, blob);
  } catch {
    throw new StoryError(500, "upload_failed");
  }
  const bytes = blob.size;

  const now = Date.now();
  if (kind === "media") {
    database.db.prepare("UPDATE spy_stories SET media_path = ?, media_bytes = ? WHERE id = ?").run(relative, bytes, id);
  } else {
    database.db.prepare("UPDATE spy_stories SET poster_path = ? WHERE id = ?").run(relative, id);
  }
  database.db.prepare(`
    UPDATE spy_stories SET ready_at = COALESCE(ready_at, ?)
    WHERE id = ? AND media_path IS NOT NULL AND poster_path IS NOT NULL
  `).run(now, id);
  const after = database.db.prepare("SELECT ready_at FROM spy_stories WHERE id = ?").get(id) as { ready_at: number | null };
  return { id, bytes, ready: after.ready_at != null };
}

// ---- listing and serving ----

/**
 * `live` = still on Instagram now; `yesterday` = the closed local day (the hub: GMT-3); `7d` =
 * today and the 6 days before; `starred` = the favourites, whatever their date.
 */
export type StoriesPeriod = "live" | "yesterday" | "7d" | "starred";
export const STORIES_PERIODS: readonly StoriesPeriod[] = ["live", "yesterday", "7d", "starred"];

export interface SpyStory {
  id: string;
  profileId: string;
  mediaType: 1 | 2;
  takenAt: number;
  expiringAt: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  links: { url: string; text?: string }[];
  music: { title: string; artist?: string } | null;
  mentions: string[];
  aiLabel: boolean;
  capturedAt: number;
  /** A favourite: kept until unstarred, whatever the days kept. */
  starredAt: number | null;
}

export interface StoriesTrayEntry {
  profileId: string;
  /** Stories in the period. */
  count: number;
  /** Stories still on Instagram, whatever the period: the tray's ring. */
  liveCount: number;
  newestAt: number;
}

type StoryRow = {
  id: string; profile_id: string; media_type: 1 | 2; taken_at: number; expiring_at: number; duration_ms: number | null;
  width: number | null; height: number | null; caption: string | null; links: string; music: string | null; mentions: string;
  ai_label: number; captured_at: number; starred_at: number | null;
};
const STORY_COLUMNS = `s.id, s.profile_id, s.media_type, s.taken_at, s.expiring_at, s.duration_ms, s.width, s.height, s.caption,
      s.links, s.music, s.mentions, s.ai_label, s.captured_at, s.starred_at`;

const parseJson = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

function toStory(r: StoryRow): SpyStory {
  return {
    id: r.id, profileId: r.profile_id, mediaType: r.media_type, takenAt: r.taken_at, expiringAt: r.expiring_at,
    durationMs: r.duration_ms, width: r.width, height: r.height, caption: r.caption,
    links: parseJson(r.links, []), music: parseJson(r.music, null), mentions: parseJson(r.mentions, []),
    aiLabel: !!r.ai_label, capturedAt: r.captured_at, starredAt: r.starred_at,
  };
}

/** The condition for a period; `now` in ms. */
function periodWhere(period: StoriesPeriod, now: number): { sql: string; params: number[] } {
  const today = dayStart(now) * 1000;
  if (period === "live") return { sql: "s.expiring_at > ?", params: [now] };
  if (period === "yesterday") return { sql: "s.taken_at >= ? AND s.taken_at < ?", params: [daysBefore(today / 1000, 1) * 1000, today] };
  if (period === "starred") return { sql: "s.starred_at IS NOT NULL", params: [] };
  return { sql: "s.taken_at >= ?", params: [daysBefore(today / 1000, 6) * 1000] };
}

/** Star or unstar a ready story; null when it is unknown or its media never arrived. */
export function setStoryStarred(database: MiniDatabase, id: string, starred: boolean, now = Date.now()): SpyStory | null {
  if (!ID_RE.test(id)) return null;
  const info = database.db.prepare("UPDATE spy_stories SET starred_at = ? WHERE id = ? AND ready_at IS NOT NULL")
    .run(starred ? now : null, id);
  if (!info.changes) return null;
  const row = database.db.prepare(`SELECT ${STORY_COLUMNS} FROM spy_stories s WHERE s.id = ?`).get(id) as StoryRow | undefined;
  return row ? toStory(row) : null;
}

/** Ready stories of the active profiles in a period, newest first, plus one tray entry per profile with any. */
export function listStories(
  database: MiniDatabase,
  period: StoriesPeriod,
  now = Date.now(),
  profileId?: string,
): { tray: StoriesTrayEntry[]; stories: SpyStory[] } {
  const where = periodWhere(period, now);
  const base = `FROM spy_stories s JOIN spy_profiles p ON p.id = s.profile_id
    WHERE s.ready_at IS NOT NULL AND p.removed_at IS NULL AND ${where.sql}`;
  const tray = (database.db.prepare(`
    SELECT s.profile_id AS profileId, COUNT(*) AS count,
      SUM(CASE WHEN s.expiring_at > ? THEN 1 ELSE 0 END) AS liveCount, MAX(s.taken_at) AS newestAt
    ${base} GROUP BY s.profile_id ORDER BY newestAt DESC
  `).all(now, ...where.params) as StoriesTrayEntry[]).map((t) => ({ ...t, liveCount: Number(t.liveCount) }));
  const rows = database.db.prepare(`
    SELECT ${STORY_COLUMNS}
    ${base} ${profileId ? "AND s.profile_id = ?" : ""} ORDER BY s.taken_at DESC, s.id DESC
  `).all(...where.params, ...(profileId ? [profileId] : [])) as StoryRow[];
  return { tray, stories: rows.map(toStory) };
}

/** The media or poster to serve for a ready story, or null (local build: no hub-worker frames). */
export function storyFile(database: MiniDatabase, _dir: MediaStore, id: string, kind: "media" | "poster"): { key: string; contentType: string } | null {
  if (!ID_RE.test(id)) return null;
  const row = database.db.prepare(
    "SELECT media_path, poster_path, media_mime, ready_at FROM spy_stories WHERE id = ?",
  ).get(id) as { media_path: string | null; poster_path: string | null; media_mime: string; ready_at: number | null } | undefined;
  if (!row || row.ready_at == null) return null;
  const relative = kind === "media" ? row.media_path : row.poster_path;
  if (!relative) return null;
  return { key: relative, contentType: kind === "media" ? row.media_mime : "image/webp" };
}

// ---- retention, removal, merge ----

function removeFiles(dir: MediaStore, rows: { media_path: string | null; poster_path: string | null }[]): void {
  dir.remove(rows.flatMap((row) => [row.media_path, row.poster_path]).filter((key): key is string => !!key));
}

/**
 * FIFO by publication: stories older than `keepDays` go, files included; so do
 * rows whose media never arrived (the CDN URL expired after ~36 h). Local build:
 * media no row names (a crash between the write and the row) are swept by
 * pruneOrphanMedia, which is async.
 */
export function pruneStories(database: MiniDatabase, dir: MediaStore, now = Date.now()): { expired: number; abandoned: number; orphans: number } {
  const { keepDays } = readStoriesSettings(database);
  // A favourite (starred_at) stays whatever its age.
  const select = database.db.prepare("SELECT id, media_path, poster_path FROM spy_stories WHERE taken_at < ? AND starred_at IS NULL");
  const expiredRows = select.all(now - keepDays * 86_400_000) as { id: string; media_path: string | null; poster_path: string | null }[];
  const abandonedRows = database.db.prepare(
    "SELECT id, media_path, poster_path FROM spy_stories WHERE ready_at IS NULL AND captured_at < ?",
  ).all(now - 36 * 3_600_000) as { id: string; media_path: string | null; poster_path: string | null }[];
  const gone = [...expiredRows, ...abandonedRows.filter((a) => !expiredRows.some((e) => e.id === a.id))];
  removeFiles(dir, gone);
  const del = database.db.prepare("DELETE FROM spy_stories WHERE id = ?");
  database.db.transaction(() => { for (const row of gone) del.run(row.id); })();

  const orphans = 0;
  return { expired: expiredRows.length, abandoned: gone.length - expiredRows.length, orphans };
}

/** A profile's stories, rows and files, gone for good (files by the paths stored, never by the current key). */
export function forgetStories(database: MiniDatabase, dir: MediaStore, profileId: string): void {
  const rows = database.db.prepare("SELECT media_path, poster_path FROM spy_stories WHERE profile_id = ?")
    .all(profileId) as { media_path: string | null; poster_path: string | null }[];
  removeFiles(dir, rows);
  database.db.prepare("DELETE FROM spy_stories WHERE profile_id = ?").run(profileId);
}

/** Merging two profiles: the rows follow, the files stay where they are. */
export function moveStories(database: MiniDatabase, intoId: string, fromId: string): void {
  database.db.prepare("UPDATE spy_stories SET profile_id = ? WHERE profile_id = ?").run(intoId, fromId);
}

/** The active Instagram profiles whose stories the extension captures, oldest saved first. */
export function trackedProfileIds(database: MiniDatabase): string[] {
  return (database.db.prepare(
    "SELECT id FROM spy_profiles WHERE platform = 'instagram' AND track_stories = 1 AND removed_at IS NULL ORDER BY saved_at",
  ).all() as { id: string }[]).map((r) => r.id);
}

/** What the stored stories take on disk (only the ones whose media arrived), and the favourites' share of it. */
export function storiesUsage(database: MiniDatabase): { bytes: number; count: number; starredBytes: number; starredCount: number } {
  const row = database.db.prepare(`
    SELECT COALESCE(SUM(media_bytes), 0) AS bytes, COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN starred_at IS NOT NULL THEN media_bytes ELSE 0 END), 0) AS starredBytes,
      SUM(CASE WHEN starred_at IS NOT NULL THEN 1 ELSE 0 END) AS starredCount
    FROM spy_stories WHERE ready_at IS NOT NULL
  `).get() as { bytes: number; count: number; starredBytes: number; starredCount: number | null };
  return { bytes: row.bytes, count: row.count, starredBytes: row.starredBytes, starredCount: row.starredCount ?? 0 };
}

/** Local build: stored media that no row names any more, deleted. `keys` = every key in the store. */
export function orphanMediaKeys(database: MiniDatabase, keys: string[]): string[] {
  const named = new Set(
    (database.db.prepare("SELECT media_path, poster_path FROM spy_stories").all() as { media_path: string | null; poster_path: string | null }[])
      .flatMap((r) => [r.media_path, r.poster_path]).filter((p): p is string => !!p),
  );
  return keys.filter((key) => !named.has(key));
}
