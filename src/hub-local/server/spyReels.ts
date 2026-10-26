import type { MiniDatabase } from "./db.js";
import { markViewsRead } from "./spyViews.js";

// Facebook "posts" are reels. Facebook exposes no total, so the extension reads
// the reels tab once in full (status running → done) and then sends the newest
// reels every day; the hub keeps each reel once and counts them.

export type ReelsStatus = "pending" | "running" | "done";

export interface ReelsBlock {
  count: number;
  status: ReelsStatus;
  doneAt: number | null;
}

export interface IngestReelsResult {
  added: number;
  known: number;
  unknown: number;
  invalid: number;
}

const REEL_ID_RE = /^\d{6,}$/;
const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function ingestReels(database: MiniDatabase, items: unknown[], now = Date.now()): IngestReelsResult {
  const out: IngestReelsResult = { added: 0, known: 0, unknown: 0, invalid: 0 };
  if (!Array.isArray(items)) return out;
  const profileStmt = database.db.prepare(
    "SELECT 1 FROM spy_profiles WHERE id = ? AND platform = 'facebook' AND removed_at IS NULL",
  );
  const insertStmt = database.db.prepare(`
    INSERT INTO spy_reels (profile_id, reel_id, created_at, duration, views, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, reel_id) DO UPDATE SET
      views = COALESCE(excluded.views, views),
      created_at = COALESCE(created_at, excluded.created_at),
      duration = COALESCE(duration, excluded.duration)
  `);
  const existsStmt = database.db.prepare("SELECT 1 FROM spy_reels WHERE profile_id = ? AND reel_id = ?");
  const touched = new Set<string>();
  for (const item of items) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const profileId = typeof r?.profileId === "string" ? r.profileId : null;
    const id = typeof r?.id === "string" ? r.id : null;
    if (!profileId || !id || !REEL_ID_RE.test(id)) {
      out.invalid += 1;
      continue;
    }
    if (!profileStmt.get(profileId)) {
      out.unknown += 1;
      continue;
    }
    const known = !!existsStmt.get(profileId, id);
    insertStmt.run(profileId, id, finite(r!.createdAt), finite(r!.duration), finite(r!.views), now);
    if (known) out.known += 1;
    else out.added += 1;
    touched.add(profileId);
  }
  refreshReelPosts(database, touched);
  return out;
}

const RANK: Record<ReelsStatus, number> = { pending: 0, running: 1, done: 2 };

/** The first full reading only moves forward: pending → running → done. */
export function ingestReelsStatus(database: MiniDatabase, items: unknown[]): { applied: number; invalid: number } {
  const out = { applied: 0, invalid: 0 };
  if (!Array.isArray(items)) return out;
  const getStmt = database.db.prepare(
    "SELECT reels_status FROM spy_profiles WHERE id = ? AND platform = 'facebook' AND removed_at IS NULL",
  );
  const setStmt = database.db.prepare("UPDATE spy_profiles SET reels_status = ?, reels_done_at = ? WHERE id = ?");
  for (const item of items) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const status = r?.status as ReelsStatus;
    const profileId = typeof r?.profileId === "string" ? r.profileId : "";
    const row = getStmt.get(profileId) as { reels_status: ReelsStatus } | undefined;
    if (!row || !(status in RANK)) {
      out.invalid += 1;
      continue;
    }
    if (RANK[status] <= RANK[row.reels_status]) continue;
    setStmt.run(status, status === "done" ? finite(r!.at) ?? Date.now() : null, profileId);
    out.applied += 1;
  }
  return out;
}

/** Writes the reel total into each profile's latest snapshot (its "posts"). */
export function refreshReelPosts(database: MiniDatabase, profileIds: Iterable<string>): void {
  const stmt = database.db.prepare(`
    UPDATE spy_snapshots
    SET posts = (SELECT COUNT(*) FROM spy_reels WHERE profile_id = @id)
    WHERE profile_id = @id
      AND day = (SELECT MAX(day) FROM spy_snapshots WHERE profile_id = @id)
      AND EXISTS (SELECT 1 FROM spy_profiles WHERE id = @id AND platform = 'facebook')
  `);
  for (const id of profileIds) stmt.run({ id });
}

/** Reels block per Facebook profile id; Instagram ids are absent. */
export function reelsBlocks(database: MiniDatabase, ids?: string[]): Map<string, ReelsBlock> {
  const rows = database.db.prepare(`
    SELECT p.id, p.reels_status AS status, p.reels_done_at AS doneAt,
      (SELECT COUNT(*) FROM spy_reels r WHERE r.profile_id = p.id) AS count
    FROM spy_profiles p WHERE p.platform = 'facebook'
  `).all() as { id: string; status: ReelsStatus; doneAt: number | null; count: number }[];
  const wanted = ids ? new Set(ids) : null;
  return new Map(
    rows.filter((r) => !wanted || wanted.has(r.id))
      .map((r) => [r.id, { count: r.count, status: r.status ?? "pending", doneAt: r.doneAt ?? null }]),
  );
}

/** Newest reel ids the extension already delivered, so it can stop paging there. */
export function recentReelIds(database: MiniDatabase, profileId: string, limit = 30): string[] {
  return (database.db.prepare(`
    SELECT reel_id FROM spy_reels WHERE profile_id = ?
    ORDER BY created_at DESC, first_seen_at DESC LIMIT ?
  `).all(profileId, limit) as { reel_id: string }[]).map((r) => r.reel_id);
}

/** Removal and re-adding start the reels over, like the follower history. */
export function forgetReels(database: MiniDatabase, profileId: string): void {
  database.db.prepare("DELETE FROM spy_reels WHERE profile_id = ?").run(profileId);
  database.db.prepare("UPDATE spy_profiles SET reels_status = 'pending', reels_done_at = NULL WHERE id = ?").run(profileId);
}

/** Merge: the kept profile gets the other's reels and the further reading state. */
export function moveReels(database: MiniDatabase, intoId: string, fromId: string): void {
  database.db.prepare(`
    INSERT OR IGNORE INTO spy_reels (profile_id, reel_id, created_at, duration, views, first_seen_at, thumb)
    SELECT ?, reel_id, created_at, duration, views, first_seen_at, thumb FROM spy_reels WHERE profile_id = ?
  `).run(intoId, fromId);
  const get = database.db.prepare("SELECT reels_status, reels_done_at FROM spy_profiles WHERE id = ?");
  const into = get.get(intoId) as { reels_status: ReelsStatus; reels_done_at: number | null };
  const from = get.get(fromId) as { reels_status: ReelsStatus; reels_done_at: number | null };
  if (from && into && RANK[from.reels_status] > RANK[into.reels_status]) {
    database.db.prepare("UPDATE spy_profiles SET reels_status = ?, reels_done_at = ? WHERE id = ?")
      .run(from.reels_status, from.reels_done_at, intoId);
  }
  refreshReelPosts(database, [intoId]);
}

// ---- collection readings ----

// `stories` readings reuse `reels_added` for the stories added; `pass` is the stories' pass by slot.
const READING_KINDS = new Set(["followers", "reels", "stories"]);
const READING_SOURCES = new Set(["daily", "visit", "manual", "initial", "catchup", "refresh", "pass"]);
export const READINGS_KEEP_MS = 7 * 86_400_000;

export interface SpyReading {
  profileId: string;
  platform: string;
  key: string;
  name: string | null;
  at: number;
  kind: string;
  source: string;
  ok: boolean;
  error: string | null;
  followers: number | null;
  reelsAdded: number | null;
  pages: number | null;
}

/** `viewsRead` collects the profiles whose reels (and so their views) were just read. */
export function ingestReadings(database: MiniDatabase, items: unknown[], now = Date.now(), viewsRead?: Set<string>) {
  const out = { recorded: 0, duplicate: 0, unknown: 0, invalid: 0 };
  if (!Array.isArray(items)) return out;
  const profileStmt = database.db.prepare("SELECT platform FROM spy_profiles WHERE id = ?");
  const insertStmt = database.db.prepare(`
    INSERT OR IGNORE INTO spy_readings
      (profile_id, at, kind, platform, source, ok, error, followers, reels_added, pages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const int = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
  for (const item of items) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const at = r?.at;
    if (!r || typeof r.profileId !== "string" || !Number.isFinite(at) || !READING_KINDS.has(r.kind as string) ||
        !READING_SOURCES.has(r.source as string) || typeof r.ok !== "boolean") {
      out.invalid += 1;
      continue;
    }
    const profile = profileStmt.get(r.profileId) as { platform: string } | undefined;
    if (!profile) {
      out.unknown += 1;
      continue;
    }
    const error = r.ok ? null : typeof r.error === "string" ? r.error.slice(0, 120) : "unknown";
    const info = insertStmt.run(r.profileId, at, r.kind, profile.platform, r.source, r.ok ? 1 : 0, error,
      int(r.followers), int(r.reelsAdded), int(r.pages));
    if (info.changes) out.recorded += 1;
    else out.duplicate += 1;
    if (r.kind === "reels" && r.ok) {
      markViewsRead(database, r.profileId, at as number);
      viewsRead?.add(r.profileId);
    }
  }
  database.db.prepare("DELETE FROM spy_readings WHERE at < ?").run(now - READINGS_KEEP_MS);
  return out;
}

export function listReadings(database: MiniDatabase, days: number, now = Date.now()): SpyReading[] {
  const span = Math.min(Math.max(1, Math.floor(days) || 3), 7);
  const rows = database.db.prepare(`
    SELECT r.profile_id AS profileId, r.platform, p.key, p.name, r.at, r.kind, r.source, r.ok, r.error,
      r.followers, r.reels_added AS reelsAdded, r.pages
    FROM spy_readings r LEFT JOIN spy_profiles p ON p.id = r.profile_id
    WHERE r.at >= ?
    ORDER BY r.at DESC
    LIMIT 3000
  `).all(now - span * 86_400_000) as (Omit<SpyReading, "ok" | "key"> & { ok: number; key: string | null })[];
  return rows.map((r) => ({ ...r, ok: !!r.ok, key: r.key ?? r.profileId.slice(r.profileId.indexOf(":") + 1) }));
}

// ---- collection health ----
// What the extension should be sending, over the last 24 h: each kind of reading,
// and the videos it collects for the analyses. A kind that only fails is a
// breakage: on 2026-10-16 Instagram moved the Reels tab's query and every views
// reading failed for three days, unnoticed among the readings above.

export type HealthStatus = "ok" | "warn" | "broken" | "stopped";

export interface HealthCheck {
  /** "<platform>:<kind>", or "analysis:video". */
  key: string;
  platform: string;
  kind: string;
  status: HealthStatus;
  /** Last 24 h. */
  attempts: number;
  ok: number;
  /** The newest success kept (readings are kept 7 days). */
  lastOkAt: number | null;
  lastError: string | null;
}

const HEALTH_SPAN_MS = 86_400_000;
/** The daily pass reads every profile's views once a day; this much later they are behind. */
const VIEWS_STALE_MS = 26 * 3_600_000;
/** A profile saved this recently has not had its first pass yet. */
const VIEWS_GRACE_MS = 3_600_000;
/** Attempts with no success at all before a kind is called broken. */
const HEALTH_BROKEN_MIN = 3;

export function healthStatus(attempts: number, ok: number): HealthStatus {
  if (!attempts) return "stopped";
  if (!ok && attempts >= HEALTH_BROKEN_MIN) return "broken";
  return ok * 2 < attempts ? "warn" : "ok";
}

export function collectionHealth(database: MiniDatabase, now = Date.now()): HealthCheck[] {
  const since = now - HEALTH_SPAN_MS;
  const rows = database.db.prepare(`
    SELECT platform, kind, SUM(at >= @since) AS attempts, SUM(at >= @since AND ok = 1) AS ok,
      MAX(CASE WHEN ok = 1 THEN at END) AS lastOkAt,
      (SELECT error FROM spy_readings e WHERE e.platform = r.platform AND e.kind = r.kind AND e.ok = 0 AND e.at >= @since
        ORDER BY e.at DESC LIMIT 1) AS lastError
    FROM spy_readings r GROUP BY platform, kind ORDER BY platform, kind
  `).all({ since }) as Omit<HealthCheck, "key" | "status">[];
  const checks: HealthCheck[] = rows.map((r) => ({ ...r, key: `${r.platform}:${r.kind}`, status: healthStatus(r.attempts, r.ok) }));
  // Local build: no analysis videos, so no "analysis:video" check (the hub reads analysis_evidence).
  // Each Instagram profile's views, read at least once a day. Every reading that ran can
  // be fine while one profile is never reached: a visit used to count as its measurement
  // and pushed it out of every batch (2026-10-19, @agnestarot_ all day).
  const profiles = database.db.prepare(`
    SELECT key, views_read_at AS viewsReadAt FROM spy_profiles
    WHERE platform = 'instagram' AND removed_at IS NULL AND saved_at < ? ORDER BY key
  `).all(now - VIEWS_GRACE_MS) as { key: string; viewsReadAt: number | null }[];
  if (profiles.length) {
    const behind = profiles.filter((p) => (p.viewsReadAt ?? 0) < now - VIEWS_STALE_MS).map((p) => `@${p.key}`);
    const ok = profiles.length - behind.length;
    checks.push({
      key: "instagram:views", platform: "instagram", kind: "views",
      status: !behind.length ? "ok" : !ok && profiles.length >= HEALTH_BROKEN_MIN ? "broken" : "warn",
      attempts: profiles.length, ok,
      lastOkAt: Math.max(0, ...profiles.map((p) => p.viewsReadAt ?? 0)) || null,
      lastError: behind.length ? `sem views há mais de 26 h: ${behind.slice(0, 3).join(", ")}${behind.length > 3 ? ` e mais ${behind.length - 3}` : ""}` : null,
    });
  }
  return checks;
}
