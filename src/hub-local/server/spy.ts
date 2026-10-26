// The spy area backend logic: profile identities, list management,
// ingest of snapshots and profile display metadata, and extension list synchronization.

import type { MiniDatabase } from "./db.js";
import { forgetReels, moveReels, recentReelIds, reelsBlocks, type ReelsBlock } from "./spyReels.js";
import { dailyBlocks, forgetPosts, movePosts, topBlocks, wantedThumbs, type DailyBlock, type TopBlock } from "./spyPosts.js";
import { forgetViews, moveViews, viewsBlocks, type ViewsBlock } from "./spyViews.js";
import { forgetStories, moveStories, storiesDirForDb, type MediaStore } from "./spyStories.js";
import { normalizeHex, pickTagColor } from "../shared/tag-colors.js";
import { renameReportTag, reportTagsOf } from "./analysis/reportTags.js";

export const SPY_PLATFORMS = ["instagram", "facebook"] as const;
export type SpyPlatform = (typeof SPY_PLATFORMS)[number];

export const SPY_MAX_ACTIVE = 100;
/**
 * How long a removed profile keeps its history, tags and notes. Saving it again
 * within this window (the panel's "desfazer", or saving it from the extension)
 * brings everything back; after it, purgeRemoved() deletes them for good.
 */
export const SPY_REMOVED_KEEP_MS = 7 * 86_400_000;
/** A profile note is a note, not a document: the panel's textarea stops here too. */
export const SPY_NOTES_MAX = 10_000;

/**
 * A link the panel will put in an href. Profile and post data come from pages
 * other people control, so only http(s) passes; anything else is dropped.
 */
export function webUrl(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (!url || url.length > max || !/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).protocol.startsWith("http") ? url : null;
  } catch {
    return null;
  }
}

export function isSpyPlatform(value: unknown): value is SpyPlatform {
  return typeof value === "string" && (SPY_PLATFORMS as readonly string[]).includes(value);
}

const IG_RESERVED = new Set([
  "explore", "reels", "reel", "p", "direct", "stories", "accounts", "tv", "guides", "challenges",
  "about", "legal", "privacy", "terms", "api", "graphql", "web", "emails", "developer", "press"
]);

const FB_RESERVED = new Set([
  "watch", "reel", "reels", "groups", "marketplace", "gaming", "events", "pages", "stories",
  "search", "hashtag", "photo", "photo.php", "photos", "video.php", "videos", "story.php",
  "permalink.php", "login", "login.php", "help", "settings", "notifications", "messages",
  "friends", "bookmarks", "saved", "ads", "business", "share", "sharer", "sharer.php", "people",
  "public", "policies", "privacy", "l.php", "plugins", "dialog", "home.php", "live", "fundraisers",
  "memories", "profile.php"
]);

const IG_KEY_RE = /^[a-z0-9._]{1,30}$/;
const FB_VANITY_RE = /^[a-z0-9.-]{1,80}$/;
const FB_NUMERIC_RE = /^\d+$/;

export function spyId(platform: string, key: string): string {
  return `${platform}:${key.toLowerCase()}`;
}

export function profileUrl(platform: string, key: string): string {
  const k = key.toLowerCase();
  if (platform === "instagram") {
    return `https://www.instagram.com/${k}/`;
  }
  if (platform === "facebook") {
    if (FB_NUMERIC_RE.test(k)) {
      return `https://www.facebook.com/profile.php?id=${k}`;
    }
    return `https://www.facebook.com/${k}`;
  }
  return "";
}

export function storiesUrl(profile: { platform: string; key: string; story_ref?: string | null; storyRef?: string | null }): string | null {
  const k = profile.key.toLowerCase();
  if (profile.platform === "instagram") {
    return `https://www.instagram.com/stories/${k}/`;
  }
  if (profile.platform === "facebook") {
    const ref = profile.storyRef ?? profile.story_ref;
    if (ref && typeof ref === "string" && ref.trim()) {
      return `https://www.facebook.com/stories/${ref.trim()}/`;
    }
    return null;
  }
  return null;
}

export function parseProfileUrl(
  input: unknown,
  platformHint?: string | null
): { platform: SpyPlatform; key: string } | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;

  // Handle bare handle or @handle when platformHint is provided
  if (platformHint && isSpyPlatform(platformHint)) {
    const cleanHandle = raw.replace(/^@+/, "").trim().toLowerCase();
    if (cleanHandle) {
      if (platformHint === "instagram") {
        if (IG_KEY_RE.test(cleanHandle) && !IG_RESERVED.has(cleanHandle)) {
          return { platform: "instagram", key: cleanHandle };
        }
      } else if (platformHint === "facebook") {
        if ((FB_NUMERIC_RE.test(cleanHandle) || FB_VANITY_RE.test(cleanHandle)) && !FB_RESERVED.has(cleanHandle)) {
          return { platform: "facebook", key: cleanHandle };
        }
      }
    }
    // If handle starts with @ and hint was given, don't fall through to URL parser
    if (raw.startsWith("@")) return null;
  }

  // If starts with @ without hint, not a valid URL
  if (raw.startsWith("@")) return null;

  // Attempt URL parsing
  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const isIg = hostname === "instagram.com" || hostname.endsWith(".instagram.com");
  const isFb = hostname === "facebook.com" || hostname.endsWith(".facebook.com");

  if (!isIg && !isFb) return null;

  const pathname = parsed.pathname;
  const segments = pathname.split("/").filter(Boolean);

  if (isIg) {
    if (!segments.length) return null;
    // Exception: /stories/<username>/...
    if (segments[0].toLowerCase() === "stories" && segments.length >= 2) {
      const candidate = segments[1].toLowerCase();
      if (IG_KEY_RE.test(candidate) && !IG_RESERVED.has(candidate)) {
        return { platform: "instagram", key: candidate };
      }
      return null;
    }
    const candidate = segments[0].toLowerCase();
    if (IG_KEY_RE.test(candidate) && !IG_RESERVED.has(candidate)) {
      return { platform: "instagram", key: candidate };
    }
    return null;
  }

  if (isFb) {
    if (!segments.length) return null;
    // Check profile.php?id=<digits>
    if (segments[0].toLowerCase() === "profile.php") {
      const idParam = parsed.searchParams.get("id");
      if (idParam && FB_NUMERIC_RE.test(idParam.trim())) {
        return { platform: "facebook", key: idParam.trim() };
      }
      return null;
    }

    const candidate = segments[0].toLowerCase();
    if ((FB_NUMERIC_RE.test(candidate) || FB_VANITY_RE.test(candidate)) && !FB_RESERVED.has(candidate)) {
      return { platform: "facebook", key: candidate };
    }
    return null;
  }

  return null;
}

function str(val: unknown, max: number): string | null {
  if (typeof val !== "string" || !val.trim()) return null;
  const t = val.trim();
  return t.length > max ? t.slice(0, max) : t;
}

function num(val: unknown): number | null {
  return typeof val === "number" && Number.isFinite(val) ? val : null;
}

export interface ListOp {
  op: "save" | "remove";
  platform: string;
  key: string;
  at: number;
}

export interface ListOpsResult {
  applied: number;
  skipped: number;
  invalid: number;
}

export function applyListOps(
  database: MiniDatabase,
  ops: unknown[],
  now = Date.now()
): ListOpsResult {
  const result: ListOpsResult = { applied: 0, skipped: 0, invalid: 0 };
  if (!Array.isArray(ops) || !ops.length) return result;

  const countActiveStmt = database.db.prepare("SELECT COUNT(*) AS count FROM spy_profiles WHERE removed_at IS NULL");
  const getStmt = database.db.prepare("SELECT id, saved_at, removed_at, list_updated_at, purged_at FROM spy_profiles WHERE id = ?");
  const insertStmt = database.db.prepare(`
    INSERT INTO spy_profiles (id, platform, key, saved_at, list_updated_at, removed_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `);
  // Saved again after its history was purged: a new start, as before.
  const reviveStmt = database.db.prepare(`
    UPDATE spy_profiles
    SET removed_at = NULL, purged_at = NULL, saved_at = ?, list_updated_at = ?,
        last_measured_at = NULL, avatar = NULL, meta_updated_at = NULL,
        last_error = NULL, last_error_at = NULL,
        tags = '[]', notes = ''
    WHERE id = ?
  `);
  // Saved again within SPY_REMOVED_KEEP_MS: everything it had is still there.
  const restoreStmt = database.db.prepare(`
    UPDATE spy_profiles SET removed_at = NULL, list_updated_at = ? WHERE id = ?
  `);
  const touchStmt = database.db.prepare(`
    UPDATE spy_profiles SET list_updated_at = ? WHERE id = ?
  `);
  // Leaves the list now; the data waits SPY_REMOVED_KEEP_MS for an undo.
  const removeStmt = database.db.prepare(`
    UPDATE spy_profiles SET removed_at = ?, list_updated_at = ? WHERE id = ?
  `);
  const clearSnapshotsStmt = database.db.prepare(`
    DELETE FROM spy_snapshots WHERE profile_id = ?
  `);

  const run = database.db.transaction((items: unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== "object") {
        result.invalid += 1;
        continue;
      }
      const raw = item as Record<string, unknown>;
      const op = raw.op;
      const platform = raw.platform;
      const keyRaw = raw.key;
      let at = num(raw.at);

      if (op !== "save" && op !== "remove") {
        result.invalid += 1;
        continue;
      }
      if (!isSpyPlatform(platform)) {
        result.invalid += 1;
        continue;
      }
      if (typeof keyRaw !== "string" || !keyRaw.trim()) {
        result.invalid += 1;
        continue;
      }
      const key = keyRaw.trim().toLowerCase();

      // Validate key format for platform
      if (platform === "instagram") {
        if (!IG_KEY_RE.test(key) || IG_RESERVED.has(key)) {
          result.invalid += 1;
          continue;
        }
      } else {
        if ((!FB_NUMERIC_RE.test(key) && !FB_VANITY_RE.test(key)) || FB_RESERVED.has(key)) {
          result.invalid += 1;
          continue;
        }
      }

      if (at == null) {
        result.invalid += 1;
        continue;
      }

      // Cap future clock skew beyond 5 minutes
      if (at > now + 5 * 60 * 1000) {
        at = now;
      }

      const id = spyId(platform, key);
      const existing = getStmt.get(id) as {
        id: string;
        saved_at: number;
        removed_at: number | null;
        list_updated_at: number;
        purged_at: number | null;
      } | undefined;

      const activeCount = (countActiveStmt.get() as { count: number }).count;

      if (!existing) {
        if (op === "remove") {
          result.skipped += 1;
          continue;
        }
        if (op === "save") {
          if (activeCount >= SPY_MAX_ACTIVE) {
            result.invalid += 1;
            continue;
          }
          insertStmt.run(id, platform, key, at, at);
          clearSnapshotsStmt.run(id);
          forgetReels(database, id);
          forgetPosts(database, id);
    forgetViews(database, id);
          result.applied += 1;
          continue;
        }
      } else {
        // Exists: newest wins. Tie or older is skipped
        if (at <= existing.list_updated_at) {
          result.skipped += 1;
          continue;
        }

        if (op === "save") {
          if (existing.removed_at != null) {
            if (activeCount >= SPY_MAX_ACTIVE) {
              result.invalid += 1;
              continue;
            }
            if (isRestorable(existing, at)) {
              restoreStmt.run(at, id);
            } else {
              // Its history is gone (or going): start from zero.
              reviveStmt.run(at, at, id);
              clearSnapshotsStmt.run(id);
              forgetReels(database, id);
              forgetPosts(database, id);
    forgetViews(database, id);
            }
            result.applied += 1;
          } else {
            // Already active
            touchStmt.run(at, id);
            result.applied += 1;
          }
        } else if (op === "remove") {
          if (existing.removed_at != null) {
            // Already removed: only the clock moves, the undo window does not restart.
            touchStmt.run(at, id);
          } else {
            removeStmt.run(at, at, id);
          }
          result.applied += 1;
        }
      }
    }
  });

  run(ops);
  return result;
}

function isRestorable(row: { removed_at: number | null; purged_at: number | null }, at: number): boolean {
  return row.removed_at != null && row.purged_at == null && at - row.removed_at <= SPY_REMOVED_KEEP_MS;
}

/**
 * Deletes the history, tags and notes of every profile removed more than
 * SPY_REMOVED_KEEP_MS ago, once. The row itself stays as the tombstone the
 * extension syncs against. Runs on boot, on every spy upload and list read.
 */
// Where the stories' files live; set once by createApp. The spy functions take
// only the database, so a module-level value keeps their signatures.
let storiesFilesDir: MediaStore | null = null;
export function setStoriesDir(dir: MediaStore): void {
  storiesFilesDir = dir;
}

export function purgeRemoved(database: MiniDatabase, now = Date.now()): number {
  const ids = (database.db.prepare(`
    SELECT id FROM spy_profiles WHERE removed_at IS NOT NULL AND purged_at IS NULL AND removed_at < ?
  `).all(now - SPY_REMOVED_KEEP_MS) as { id: string }[]).map((r) => r.id);
  for (const id of ids) purgeProfile(database, id, now);
  return ids.length;
}

/** The history of one removed profile, gone for good. */
function purgeProfile(database: MiniDatabase, id: string, now = Date.now()): void {
  database.db.transaction(() => {
    database.db.prepare("DELETE FROM spy_snapshots WHERE profile_id = ?").run(id);
    forgetReels(database, id);
    forgetPosts(database, id);
    forgetViews(database, id);
    forgetStories(database, storiesFilesDir ?? storiesDirForDb(database), id);
    database.db.prepare(`
      UPDATE spy_profiles
      SET last_measured_at = NULL, avatar = NULL, meta_updated_at = NULL,
          last_error = NULL, last_error_at = NULL, tags = '[]', notes = '', purged_at = ?
      WHERE id = ? AND removed_at IS NOT NULL
    `).run(now, id);
  })();
}

export function saveProfile(
  database: MiniDatabase,
  platform: string,
  key: string,
  at = Date.now()
): { id: string; status: "created" | "restored" | "already_active" } {
  if (!isSpyPlatform(platform)) {
    throw new Error("invalid_profile");
  }
  const cleanKey = key.trim().toLowerCase();
  if (platform === "instagram") {
    if (!IG_KEY_RE.test(cleanKey) || IG_RESERVED.has(cleanKey)) {
      throw new Error("invalid_profile");
    }
  } else {
    if ((!FB_NUMERIC_RE.test(cleanKey) && !FB_VANITY_RE.test(cleanKey)) || FB_RESERVED.has(cleanKey)) {
      throw new Error("invalid_profile");
    }
  }

  const id = spyId(platform, cleanKey);
  const existing = database.db
    .prepare("SELECT id, removed_at, list_updated_at, purged_at FROM spy_profiles WHERE id = ?")
    .get(id) as { id: string; removed_at: number | null; list_updated_at: number; purged_at: number | null } | undefined;

  const countActive = (
    database.db.prepare("SELECT COUNT(*) AS count FROM spy_profiles WHERE removed_at IS NULL").get() as { count: number }
  ).count;

  // Dashboard actions arrive in order at the authority; two actions can share
  // the same wall-clock millisecond (or follow a client with a fast clock).
  at = Math.max(at, (existing?.list_updated_at ?? -1) + 1);

  if (!existing || existing.removed_at != null) {
    if (countActive >= SPY_MAX_ACTIVE) {
      throw new Error("limit_reached");
    }
    const restored = !!existing && isRestorable(existing, at);
    const res = applyListOps(database, [{ op: "save", platform, key: cleanKey, at }], at);
    if (!res.applied) {
      throw new Error("limit_reached");
    }
    return { id, status: restored ? "restored" : "created" };
  }

  applyListOps(database, [{ op: "save", platform, key: cleanKey, at }], at);
  return { id, status: "already_active" };
}

export function removeProfile(
  database: MiniDatabase,
  id: string,
  at = Date.now(),
  /** Delete the history now instead of keeping it for an undo (a merge moved it already). */
  { purge = false }: { purge?: boolean } = {},
): boolean {
  const existing = database.db.prepare("SELECT id, platform, key, list_updated_at FROM spy_profiles WHERE id = ?").get(id) as {
    id: string;
    platform: string;
    key: string;
    list_updated_at: number;
  } | undefined;
  if (!existing) return false;

  at = Math.max(at, existing.list_updated_at + 1);

  applyListOps(database, [{ op: "remove", platform: existing.platform, key: existing.key, at }], at);
  if (purge) purgeProfile(database, id, at);
  return true;
}

export interface IngestProfilesResult {
  updated: number;
  skipped: number;
  invalid: number;
  unknown: number;
}

const AVATAR_RE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const IDENT_RE = /^[A-Za-z0-9_:.=-]{1,80}$/;

export function ingestProfiles(database: MiniDatabase, patches: unknown[]): IngestProfilesResult {
  const out: IngestProfilesResult = { updated: 0, skipped: 0, invalid: 0, unknown: 0 };
  if (!Array.isArray(patches) || !patches.length) return out;

  const getStmt = database.db.prepare(`
    SELECT id, user_id, name, avatar, bio, external_url, verified, private, story_ref,
           removed_at, meta_updated_at
    FROM spy_profiles WHERE id = ?
  `);
  const updateStmt = database.db.prepare(`
    UPDATE spy_profiles SET
      user_id = ?,
      name = ?,
      avatar = ?,
      bio = ?,
      external_url = ?,
      verified = ?,
      private = ?,
      story_ref = ?,
      meta_updated_at = ?
    WHERE id = ?
  `);

  const run = database.db.transaction((list: unknown[]) => {
    for (const item of list) {
      if (!item || typeof item !== "object") {
        out.invalid += 1;
        continue;
      }
      const p = item as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id.trim() : null;
      const at = num(p.at);

      if (!id || at == null) {
        out.invalid += 1;
        continue;
      }

      const existing = getStmt.get(id) as {
        id: string;
        user_id: string | null;
        name: string | null;
        avatar: string | null;
        bio: string | null;
        external_url: string | null;
        verified: number | null;
        private: number | null;
        story_ref: string | null;
        removed_at: number | null;
        meta_updated_at: number | null;
      } | undefined;

      if (!existing) {
        out.unknown += 1;
        continue;
      }
      if (existing.removed_at != null) {
        out.skipped += 1;
        continue;
      }
      if (existing.meta_updated_at != null && at < existing.meta_updated_at) {
        out.skipped += 1;
        continue;
      }

      const name = str(p.name, 200) ?? existing.name;
      const bio = str(p.bio, 2000) ?? existing.bio;
      const externalUrl = webUrl(p.externalUrl ?? p.external_url) ?? existing.external_url;

      let userId = existing.user_id;
      if (p.userId != null) {
        const u = String(p.userId).trim();
        if (IDENT_RE.test(u)) userId = u;
      }

      let storyRef = existing.story_ref;
      if (p.storyRef != null) {
        const s = String(p.storyRef).trim();
        if (IDENT_RE.test(s)) storyRef = s;
      }

      let avatar = existing.avatar;
      if (p.avatar === null || p.avatar === "") {
        avatar = null;
      } else if (typeof p.avatar === "string") {
        const av = p.avatar.trim();
        if (av.length <= 80000 && AVATAR_RE.test(av)) {
          avatar = av;
        }
      }

      let verified = existing.verified;
      if (typeof p.verified === "boolean") verified = p.verified ? 1 : 0;
      else if (p.verified === 0 || p.verified === 1) verified = p.verified;

      let priv = existing.private;
      if (typeof p.private === "boolean") priv = p.private ? 1 : 0;
      else if (p.private === 0 || p.private === 1) priv = p.private;

      updateStmt.run(userId, name, avatar, bio, externalUrl, verified, priv, storyRef, at, id);
      out.updated += 1;
    }
  });

  run(patches);
  return out;
}

export interface IngestSnapshotsResult {
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  unknown: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function ingestSnapshots(
  database: MiniDatabase,
  snaps: unknown[],
  now = Date.now()
): IngestSnapshotsResult {
  const out: IngestSnapshotsResult = { created: 0, updated: 0, skipped: 0, invalid: 0, unknown: 0 };
  if (!Array.isArray(snaps) || !snaps.length) return out;

  const profileStmt = database.db.prepare("SELECT id, removed_at, last_measured_at FROM spy_profiles WHERE id = ?");
  const snapStmt = database.db.prepare("SELECT * FROM spy_snapshots WHERE profile_id = ? AND day = ?");
  const insertStmt = database.db.prepare(`
    INSERT INTO spy_snapshots (
      profile_id, day, measured_at, followers, followers_approx, following, posts, has_story, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = database.db.prepare(`
    UPDATE spy_snapshots SET
      measured_at = ?,
      followers = ?,
      followers_approx = ?,
      following = ?,
      posts = ?,
      has_story = ?,
      source = ?
    WHERE profile_id = ? AND day = ?
  `);
  const updateProfileStmt = database.db.prepare(`
    UPDATE spy_profiles SET
      last_measured_at = MAX(coalesce(last_measured_at, 0), ?),
      last_error = CASE WHEN coalesce(last_error_at, 0) <= ? THEN NULL ELSE last_error END,
      last_error_at = CASE WHEN coalesce(last_error_at, 0) <= ? THEN NULL ELSE last_error_at END
    WHERE id = ?
  `);

  const run = database.db.transaction((list: unknown[]) => {
    for (const item of list) {
      if (!item || typeof item !== "object") {
        out.invalid += 1;
        continue;
      }
      const s = item as Record<string, unknown>;
      const profileId = typeof s.profileId === "string" ? s.profileId.trim() : null;
      const day = typeof s.day === "string" ? s.day.trim() : null;
      const measuredAt = num(s.measuredAt);
      const source = s.source;

      if (!profileId || !day || measuredAt == null) {
        out.invalid += 1;
        continue;
      }
      if (!DAY_RE.test(day)) {
        out.invalid += 1;
        continue;
      }
      // Day cannot be more than 2 days in future relative to server
      const dayTime = new Date(`${day}T00:00:00Z`).getTime();
      if (Number.isNaN(dayTime) || dayTime > now + 2 * 86400 * 1000) {
        out.invalid += 1;
        continue;
      }
      if (source !== "visit" && source !== "daily") {
        out.invalid += 1;
        continue;
      }

      // Metric counts: non-negative integers or null
      const parseCount = (v: unknown): number | null => {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.trunc(v);
        return null;
      };

      const followers = parseCount(s.followers);
      const following = parseCount(s.following);
      const posts = parseCount(s.posts);
      let hasStory: number | null = null;
      if (typeof s.hasStory === "boolean") hasStory = s.hasStory ? 1 : 0;
      else if (s.hasStory === 1 || s.hasStory === 0) hasStory = s.hasStory;

      const followersApprox = s.followersApprox === true || s.followersApprox === 1 ? 1 : 0;

      // At least one metric must be present
      if (followers == null && following == null && posts == null && hasStory == null) {
        out.invalid += 1;
        continue;
      }

      const profile = profileStmt.get(profileId) as {
        id: string;
        removed_at: number | null;
        last_measured_at: number | null;
      } | undefined;

      if (!profile) {
        out.unknown += 1;
        continue;
      }
      if (profile.removed_at != null) {
        out.skipped += 1;
        continue;
      }

      const existingSnap = snapStmt.get(profileId, day) as {
        profile_id: string;
        day: string;
        measured_at: number;
        followers: number | null;
        followers_approx: number;
        following: number | null;
        posts: number | null;
        has_story: number | null;
        source: string;
      } | undefined;

      if (!existingSnap) {
        insertStmt.run(
          profileId,
          day,
          measuredAt,
          followers,
          followersApprox,
          following,
          posts,
          hasStory,
          source
        );
        updateProfileStmt.run(measuredAt, measuredAt, measuredAt, profileId);
        out.created += 1;
      } else {
        if (measuredAt < existingSnap.measured_at) {
          out.skipped += 1;
          continue;
        }

        const finalFollowers = followers != null ? followers : existingSnap.followers;
        const finalApprox = followers != null ? followersApprox : existingSnap.followers_approx;
        const finalFollowing = following != null ? following : existingSnap.following;
        const finalPosts = posts != null ? posts : existingSnap.posts;
        const finalHasStory = hasStory != null ? hasStory : existingSnap.has_story;

        updateStmt.run(
          measuredAt,
          finalFollowers,
          finalApprox,
          finalFollowing,
          finalPosts,
          finalHasStory,
          source,
          profileId,
          day
        );
        updateProfileStmt.run(measuredAt, measuredAt, measuredAt, profileId);
        out.updated += 1;
      }
    }
  });

  run(snaps);
  return out;
}

export interface IngestErrorsResult {
  recorded: number;
  unknown: number;
}

export function ingestErrors(database: MiniDatabase, errors: unknown[]): IngestErrorsResult {
  const out: IngestErrorsResult = { recorded: 0, unknown: 0 };
  if (!Array.isArray(errors) || !errors.length) return out;

  const profileStmt = database.db.prepare("SELECT id FROM spy_profiles WHERE id = ?");
  const updateStmt = database.db.prepare(`
    UPDATE spy_profiles SET last_error = ?, last_error_at = ? WHERE id = ?
      AND removed_at IS NULL AND coalesce(last_measured_at, 0) < ?
      AND coalesce(last_error_at, 0) <= ?
  `);

  const run = database.db.transaction((list: unknown[]) => {
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const profileId = typeof e.profileId === "string" ? e.profileId.trim() : null;
      const err = str(e.error, 500);
      const at = num(e.at) ?? Date.now();

      if (!profileId || !err) continue;

      const profile = profileStmt.get(profileId);
      if (!profile) {
        out.unknown += 1;
        continue;
      }

      out.recorded += updateStmt.run(err, at, profileId, at, at).changes;
    }
  });

  run(errors);
  return out;
}

export interface ExtensionProfile {
  id: string;
  platform: SpyPlatform;
  key: string;
  name: string | null;
  userId: string | null;
  savedAt: number;
  removedAt: number | null;
  listUpdatedAt: number;
  lastMeasuredAt: number | null;
  /** Instagram: the last reading of the views (Reels tab), by any browser. A visit reads the followers only. */
  viewsReadAt: number | null;
  hasAvatar: boolean;
  /** Facebook only: reading state, total and the newest reel ids already stored. */
  reels?: { status: ReelsBlock["status"]; count: number; recent: string[] };
  /** Ids of this week's top 3 that have no thumbnail yet. */
  wantThumbs?: string[];
  /** Instagram only: the extension captures this profile's stories. */
  trackStories: boolean;
  /** Tracked profiles: ids of the stories captured in the last 48 h, so the extension skips them. */
  storyPks?: string[];
}

export function listForExtension(
  database: MiniDatabase,
  /** Every active profile's top 3, when the caller just computed it. */
  top?: Map<string, TopBlock>,
): ExtensionProfile[] {
  const rows = database.db.prepare(`
    SELECT
      id,
      platform,
      key,
      name,
      user_id AS userId,
      saved_at AS savedAt,
      removed_at AS removedAt,
      list_updated_at AS listUpdatedAt,
      last_measured_at AS lastMeasuredAt,
      views_read_at AS viewsReadAt,
      (avatar IS NOT NULL AND length(avatar) > 0) AS hasAvatar,
      track_stories AS trackStories
    FROM spy_profiles
    ORDER BY saved_at DESC
  `).all() as (Omit<ExtensionProfile, "hasAvatar" | "trackStories"> & { hasAvatar: number; trackStories: number })[];

  const blocks = reelsBlocks(database);
  const wanted = wantedThumbs(database, Date.now(), top);
  const now = Date.now();
  const recentStories = database.db.prepare(
    "SELECT id FROM spy_stories WHERE profile_id = ? AND captured_at >= ? ORDER BY taken_at DESC",
  );
  return rows.map((r) => {
    const block = r.removedAt == null ? blocks.get(r.id) : undefined;
    const tracked = !!r.trackStories && r.removedAt == null;
    return {
      ...r,
      hasAvatar: !!r.hasAvatar,
      trackStories: tracked,
      ...(tracked ? { storyPks: (recentStories.all(r.id, now - 48 * 3_600_000) as { id: string }[]).map((s) => s.id) } : {}),
      // The top 3 still missing a thumbnail: the extension sends them when it next sees them.
      ...(wanted.has(r.id) ? { wantThumbs: wanted.get(r.id) } : {}),
      ...(block ? { reels: { status: block.status, count: block.count, recent: recentReelIds(database, r.id) } } : {}),
    };
  });
}

export function getAvatarBytes(
  database: MiniDatabase,
  id: string
): { body: Buffer; contentType: string } | null {
  const row = database.db
    .prepare("SELECT avatar FROM spy_profiles WHERE id = ?")
    .get(id) as { avatar: string | null } | undefined;
  const avatar = row?.avatar;
  if (!avatar) return null;
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(avatar);
  if (!m) return null;
  return { body: Buffer.from(m[2], "base64"), contentType: m[1] };
}

export interface SpySnapshot {
  day: string;
  measuredAt: number;
  followers: number | null;
  followersApprox: boolean;
  following: number | null;
  posts: number | null;
  hasStory: boolean | null;
  source: "visit" | "daily";
}

export interface SpyCard {
  id: string;
  platform: SpyPlatform;
  key: string;
  userId: string | null;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  externalUrl: string | null;
  verified: boolean | null;
  private: boolean | null;
  profileUrl: string;
  storiesUrl: string | null;
  savedAt: number;
  lastMeasuredAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  latest: SpySnapshot | null;
  delta7: number | null;
  delta30: number | null;
  deltaTotal: number | null;
  spark: { day: string; followers: number }[];
  tags: string[];
  notes: string;
  /** Instagram only: the extension captures this profile's stories. */
  trackStories: boolean;
  /** Other active profiles of the same network with the same user id: one
   *  account saved twice (renamed handle, Facebook vanity and numeric id). */
  sameAccountAs: string[];
  /** Facebook only: reels counted so far and the first full reading's state. */
  reels: ReelsBlock | null;
  /** Posts (Instagram) or reels (Facebook) per day: the last days' publication times. */
  daily: DailyBlock | null;
  /** Top 3 posts (Instagram) or reels (Facebook) of the last 7 days. */
  top: TopBlock | null;
  /** Views of the reels of the 24 h, 3 and 7 days before the last reading of the views. */
  views: ViewsBlock | null;
}

export function subtractDays(dayStr: string, days: number): string {
  const d = new Date(`${dayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface RawProfileRow {
  id: string;
  platform: SpyPlatform;
  key: string;
  user_id: string | null;
  name: string | null;
  bio: string | null;
  external_url: string | null;
  verified: number | null;
  private: number | null;
  story_ref: string | null;
  saved_at: number;
  list_updated_at: number;
  meta_updated_at: number | null;
  last_measured_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  has_avatar: number;
  tags?: string | null;
  notes?: string | null;
  track_stories?: number | null;
}

interface RawSnapshotRow {
  profile_id: string;
  day: string;
  measured_at: number;
  followers: number | null;
  followers_approx: number;
  following: number | null;
  posts: number | null;
  has_story: number | null;
  source: string;
}

export function toSnapshot(row: RawSnapshotRow): SpySnapshot {
  return {
    day: row.day,
    measuredAt: row.measured_at,
    followers: row.followers,
    followersApprox: !!row.followers_approx,
    following: row.following,
    posts: row.posts,
    hasStory: row.has_story === null ? null : !!row.has_story,
    source: row.source as "visit" | "daily",
  };
}

export function buildCard(profile: RawProfileRow, rawSnaps: RawSnapshotRow[]): SpyCard {
  const sorted = [...rawSnaps].sort((a, b) => {
    const d = a.day.localeCompare(b.day);
    if (d !== 0) return d;
    return a.measured_at - b.measured_at;
  });

  const latestRow = sorted.length ? sorted[sorted.length - 1] : null;
  const latest = latestRow ? toSnapshot(latestRow) : null;

  const withFollowers = sorted.filter((s) => s.followers != null);
  const spark = withFollowers.slice(-30).map((s) => ({
    day: s.day,
    followers: s.followers as number,
  }));

  let delta7: number | null = null;
  let delta30: number | null = null;
  let deltaTotal: number | null = null;
  if (latest && latest.followers != null) {
    // "em 7 dias" must compare with a measurement about 7 days old. With gaps
    // the nearest one may be weeks away; then there is no honest number.
    const growth = (days: number, tolerance: number): number | null => {
      const target = Date.parse(`${subtractDays(latest.day, days)}T00:00:00Z`);
      let best: RawSnapshotRow | null = null;
      let bestOff = Infinity;
      for (const s of withFollowers) {
        if (s === latestRow) continue;
        const off = Math.abs(Date.parse(`${s.day}T00:00:00Z`) - target) / 86_400_000;
        // Ties go to the older point, which covers at least the full period.
        if (off <= tolerance && (off < bestOff || (off === bestOff && best && s.day < best.day))) {
          best = s;
          bestOff = off;
        }
      }
      return best ? (latest.followers as number) - (best.followers as number) : null;
    };
    delta7 = growth(7, 3);
    delta30 = growth(30, 7);

    if (withFollowers.length > 1) {
      const first = withFollowers[0];
      if (first && first.followers != null && first !== latestRow) {
        deltaTotal = latest.followers - first.followers;
      }
    }
  }

  const vParam = profile.meta_updated_at ?? profile.saved_at;
  const avatarUrl = profile.has_avatar
    ? `/api/spy/profiles/${encodeURIComponent(profile.id)}/avatar?v=${vParam}`
    : null;

  let tags: string[] = [];
  if (profile.tags) {
    try {
      const parsed = JSON.parse(profile.tags);
      if (Array.isArray(parsed)) {
        tags = parsed.map((t) => String(t).trim()).filter(Boolean);
      }
    } catch {
      tags = [];
    }
  }
  const notes = typeof profile.notes === "string" ? profile.notes : "";

  return {
    id: profile.id,
    platform: profile.platform,
    key: profile.key,
    userId: profile.user_id,
    name: profile.name,
    avatarUrl,
    bio: profile.bio,
    externalUrl: profile.external_url,
    verified: profile.verified === null ? null : !!profile.verified,
    private: profile.private === null ? null : !!profile.private,
    profileUrl: profileUrl(profile.platform, profile.key),
    storiesUrl: storiesUrl({
      platform: profile.platform,
      key: profile.key,
      storyRef: profile.story_ref,
    }),
    savedAt: profile.saved_at,
    lastMeasuredAt: profile.last_measured_at,
    lastError: profile.last_error,
    lastErrorAt: profile.last_error_at,
    latest,
    delta7,
    delta30,
    deltaTotal,
    spark,
    tags,
    notes,
    trackStories: !!profile.track_stories,
    sameAccountAs: [],
    reels: null,
    daily: null,
    top: null,
    views: null,
  };
}

function withReels(database: MiniDatabase, cards: SpyCard[]): SpyCard[] {
  const blocks = reelsBlocks(database, cards.filter((c) => c.platform === "facebook").map((c) => c.id));
  const daily = dailyBlocks(database, cards);
  const top = topBlocks(database, cards, Date.now(), daily);
  const views = viewsBlocks(database, cards, daily);
  for (const card of cards) {
    card.reels = blocks.get(card.id) ?? null;
    card.daily = daily.get(card.id) ?? null;
    card.top = top.get(card.id) ?? null;
    card.views = views.get(card.id) ?? null;
  }
  return cards;
}

/** Fills `sameAccountAs` from the active profiles' network user ids. */
function withSameAccount(database: MiniDatabase, cards: SpyCard[]): SpyCard[] {
  const rows = database.db.prepare(`
    SELECT id, platform, user_id FROM spy_profiles
    WHERE removed_at IS NULL AND user_id IS NOT NULL AND user_id != ''
  `).all() as { id: string; platform: string; user_id: string }[];
  const byAccount = new Map<string, string[]>();
  for (const row of rows) {
    const account = `${row.platform}:${row.user_id}`;
    const ids = byAccount.get(account);
    if (ids) ids.push(row.id);
    else byAccount.set(account, [row.id]);
  }
  for (const card of cards) {
    const ids = card.userId ? byAccount.get(`${card.platform}:${card.userId}`) ?? [] : [];
    card.sameAccountAs = ids.filter((id) => id !== card.id);
  }
  return cards;
}

/**
 * Folds `fromId` into `intoId` when both are the same account: snapshots for days
 * the kept profile lacks move over (its own measurement wins a shared day), tags
 * are united, notes kept, and `fromId` is removed like any other removal so the
 * extension drops it on its next list sync.
 */
export function mergeProfiles(database: MiniDatabase, intoId: string, fromId: string, at = Date.now()): SpyCard {
  if (intoId === fromId) throw new Error("invalid");
  type Row = { id: string; platform: string; user_id: string | null; tags: string; notes: string; last_measured_at: number | null };
  const get = database.db.prepare(
    "SELECT id, platform, user_id, tags, notes, last_measured_at FROM spy_profiles WHERE id = ? AND removed_at IS NULL",
  );
  const into = get.get(intoId) as Row | undefined;
  const from = get.get(fromId) as Row | undefined;
  if (!into || !from) throw new Error("not_found");
  if (into.platform !== from.platform || !into.user_id || into.user_id !== from.user_id) {
    throw new Error("different_account");
  }
  const parse = (raw: string) => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
  const intoTags = parse(into.tags);
  const known = new Set(intoTags.map((t) => t.toLowerCase()));
  const tags = [...intoTags, ...parse(from.tags).filter((t) => !known.has(t.toLowerCase()))];
  const notes = !from.notes || from.notes === into.notes ? into.notes : into.notes ? `${into.notes}\n\n${from.notes}` : from.notes;
  const lastMeasured = Math.max(into.last_measured_at ?? 0, from.last_measured_at ?? 0) || null;

  database.db.transaction(() => {
    database.db.prepare(`
      INSERT OR IGNORE INTO spy_snapshots
        (profile_id, day, measured_at, followers, followers_approx, following, posts, has_story, source)
      SELECT ?, day, measured_at, followers, followers_approx, following, posts, has_story, source
      FROM spy_snapshots WHERE profile_id = ?
    `).run(intoId, fromId);
    database.db.prepare("UPDATE spy_profiles SET tags = ?, notes = ?, last_measured_at = ? WHERE id = ?")
      .run(JSON.stringify(tags), notes, lastMeasured, intoId);
    moveReels(database, intoId, fromId);
    movePosts(database, intoId, fromId);
    moveViews(database, intoId, fromId);
    moveStories(database, intoId, fromId);
    // Its history now lives in the kept profile; nothing to keep for an undo.
    removeProfile(database, fromId, at, { purge: true });
  })();
  return getCard(database, intoId)!;
}

export function listCards(database: MiniDatabase): SpyCard[] {
  const profiles = database.db.prepare(`
    SELECT
      id, platform, key, user_id, name, bio, external_url, verified, private, story_ref,
      saved_at, list_updated_at, meta_updated_at, last_measured_at, last_error, last_error_at,
      tags, notes, track_stories,
      (avatar IS NOT NULL AND length(avatar) > 0) AS has_avatar
    FROM spy_profiles
    WHERE removed_at IS NULL
    ORDER BY saved_at DESC
  `).all() as RawProfileRow[];

  if (!profiles.length) return [];

  // Fetch at most 36 distinct points per profile: 30 spark points, latest,
  // first follower count and the comparison candidates. Old profiles retain
  // their measurements without transferring their entire history to JS.
  const slices = [
    "SELECT day FROM spy_snapshots WHERE profile_id = p.id AND followers IS NOT NULL ORDER BY day DESC LIMIT 30",
    "SELECT MAX(day) FROM spy_snapshots WHERE profile_id = p.id",
    "SELECT MIN(day) FROM spy_snapshots WHERE profile_id = p.id AND followers IS NOT NULL",
    // Nearest measured day on each side of the 7- and 30-day targets.
    ...[7, 30].flatMap((days) => [["MAX", "<="], ["MIN", ">="]].map(([pick, cmp]) => `SELECT ${pick}(day) FROM spy_snapshots
      WHERE profile_id = p.id AND followers IS NOT NULL AND day ${cmp} date(
        (SELECT MAX(day) FROM spy_snapshots WHERE profile_id = p.id), '-${days} days')`)),
  ];
  const snaps = database.db.prepare(slices.map((slice) => `
    SELECT s.* FROM spy_profiles p JOIN spy_snapshots s
      ON s.profile_id = p.id AND s.day IN (${slice})
    WHERE p.removed_at IS NULL
  `).join(" UNION ")).all() as RawSnapshotRow[];

  const byProfile = new Map<string, RawSnapshotRow[]>();
  for (const snap of snaps) {
    let list = byProfile.get(snap.profile_id);
    if (!list) {
      list = [];
      byProfile.set(snap.profile_id, list);
    }
    list.push(snap);
  }

  return withReels(database, withSameAccount(database, profiles.map((p) => buildCard(p, byProfile.get(p.id) ?? []))));
}

export function getCard(database: MiniDatabase, id: string): SpyCard | null {
  return getHistory(database, id)?.profile ?? null;
}

export function getHistory(
  database: MiniDatabase,
  id: string
): { profile: SpyCard; snapshots: SpySnapshot[] } | null {
  const profile = database.db.prepare(`
    SELECT
      id, platform, key, user_id, name, bio, external_url, verified, private, story_ref,
      saved_at, list_updated_at, meta_updated_at, last_measured_at, last_error, last_error_at,
      tags, notes, track_stories,
      (avatar IS NOT NULL AND length(avatar) > 0) AS has_avatar
    FROM spy_profiles
    WHERE id = ? AND removed_at IS NULL
  `).get(id) as RawProfileRow | undefined;

  if (!profile) return null;

  const snaps = database.db.prepare(`
    SELECT
      profile_id, day, measured_at, followers, followers_approx, following, posts, has_story, source
    FROM spy_snapshots
    WHERE profile_id = ?
    ORDER BY day ASC, measured_at ASC
  `).all(id) as RawSnapshotRow[];

  const [card] = withReels(database, withSameAccount(database, [buildCard(profile, snaps)]));
  return { profile: card, snapshots: snaps.map(toSnapshot) };
}

export interface SpyTagItem {
  name: string;
  color: string;
  count: number;
}

export function listSpyTags(database: MiniDatabase): { tags: SpyTagItem[] } {
  const rows = database.db
    .prepare("SELECT name, color FROM spy_tags ORDER BY name COLLATE NOCASE ASC")
    .all() as { name: string; color: string }[];

  const profiles = database.db
    .prepare("SELECT tags FROM spy_profiles WHERE removed_at IS NULL")
    .all() as { tags: string }[];

  const tally = new Map<string, number>();
  for (const p of profiles) {
    try {
      const tags = JSON.parse(p.tags || "[]");
      if (Array.isArray(tags)) {
        for (const t of tags) {
          if (typeof t === "string" && t.trim()) {
            const key = t.trim();
            tally.set(key, (tally.get(key) ?? 0) + 1);
          }
        }
      }
    } catch {}
  }

  return {
    tags: rows.map((r) => ({
      name: r.name,
      color: r.color,
      count: tally.get(r.name) ?? 0,
    })),
  };
}

export function addSpyTags(
  database: MiniDatabase,
  items: (string | { name: string; color?: string })[]
): { tags: SpyTagItem[] } {
  const existingRows = database.db
    .prepare("SELECT name, color FROM spy_tags")
    .all() as { name: string; color: string }[];
  const existingMap = new Map(existingRows.map((r) => [r.name.toLowerCase(), r]));
  const spentColors = existingRows.map((r) => r.color);

  const insertStmt = database.db.prepare(
    "INSERT INTO spy_tags (name, color, created_at) VALUES (?, ?, ?)"
  );

  database.db.transaction(() => {
    for (const item of items) {
      const rawName = typeof item === "string" ? item : item.name;
      const name = typeof rawName === "string" ? rawName.trim() : "";
      if (!name || name.length > 100 || name.includes(",")) continue;
      if (existingMap.has(name.toLowerCase())) continue;

      let color: string | null = null;
      if (typeof item === "object" && item.color) {
        color = normalizeHex(item.color);
      }
      if (!color) {
        color = pickTagColor(spentColors);
        spentColors.push(color);
      }

      insertStmt.run(name, color, Date.now());
      existingMap.set(name.toLowerCase(), { name, color });
    }
  })();

  return listSpyTags(database);
}

export function recolorSpyTag(database: MiniDatabase, name: string, color: string) {
  const hex = normalizeHex(color);
  if (!hex) throw new Error("invalid_color");
  const row = database.db
    .prepare("SELECT name, color FROM spy_tags WHERE name = ? COLLATE NOCASE")
    .get(name) as { name: string; color: string } | undefined;
  if (!row) throw new Error("tag_not_found");

  database.db.prepare("UPDATE spy_tags SET color = ? WHERE name = ?").run(hex, row.name);
  return { name: row.name, color: hex };
}

export function renameSpyTag(database: MiniDatabase, from: string, to: string) {
  const targetTo = to.trim();
  if (!targetTo || targetTo.length > 100 || targetTo.includes(",")) throw new Error("invalid_name");
  const fromRow = database.db
    .prepare("SELECT name, color FROM spy_tags WHERE name = ? COLLATE NOCASE")
    .get(from) as { name: string; color: string } | undefined;
  if (!fromRow) throw new Error("tag_not_found");
  if (fromRow.name === targetTo) return { name: targetTo, color: fromRow.color, affected: 0 };

  const toRow = database.db
    .prepare("SELECT name, color FROM spy_tags WHERE name = ? COLLATE NOCASE")
    .get(targetTo) as { name: string; color: string } | undefined;

  const finalName = toRow && toRow.name !== fromRow.name ? toRow.name : targetTo;
  let affected = 0;
  database.db.transaction(() => {
    if (toRow && toRow.name !== fromRow.name) {
      database.db.prepare("DELETE FROM spy_tags WHERE name = ?").run(fromRow.name);
    } else {
      database.db.prepare("UPDATE spy_tags SET name = ? WHERE name = ?").run(finalName, fromRow.name);
    }
    // The reports' rule follows the tag (hub 0.49).
    renameReportTag(database, fromRow.name, finalName);

    const profiles = database.db
      .prepare("SELECT id, tags FROM spy_profiles WHERE EXISTS (SELECT 1 FROM json_each(spy_profiles.tags) WHERE lower(value) = lower(?))")
      .all(fromRow.name) as { id: string; tags: string }[];
    const updateStmt = database.db.prepare("UPDATE spy_profiles SET tags = ? WHERE id = ?");
    for (const p of profiles) {
      try {
        const tags = JSON.parse(p.tags || "[]");
        if (Array.isArray(tags) && tags.some((t) => String(t).toLowerCase() === fromRow.name.toLowerCase())) {
          const nextTags = [...new Set(tags.map((t) => (String(t).toLowerCase() === fromRow.name.toLowerCase() ? finalName : t)))];
          updateStmt.run(JSON.stringify(nextTags), p.id);
          affected++;
        }
      } catch {}
    }
  })();

  return { name: finalName, color: toRow?.color ?? fromRow.color, affected };
}

export function deleteSpyTag(database: MiniDatabase, name: string) {
  const row = database.db
    .prepare("SELECT name FROM spy_tags WHERE name = ? COLLATE NOCASE")
    .get(name) as { name: string } | undefined;
  if (!row) throw new Error("tag_not_found");
  // A tag the reports read stays until the rule lets go of it (hub 0.49).
  if (reportTagsOf(database).some((t) => t.toLowerCase() === row.name.toLowerCase())) throw new Error("tag_in_report_rule");

  let affected = 0;
  database.db.transaction(() => {
    database.db.prepare("DELETE FROM spy_tags WHERE name = ?").run(row.name);

    const profiles = database.db
      .prepare("SELECT id, tags FROM spy_profiles WHERE EXISTS (SELECT 1 FROM json_each(spy_profiles.tags) WHERE lower(value) = lower(?))")
      .all(row.name) as { id: string; tags: string }[];
    const updateStmt = database.db.prepare("UPDATE spy_profiles SET tags = ? WHERE id = ?");
    for (const p of profiles) {
      try {
        const tags = JSON.parse(p.tags || "[]");
        if (Array.isArray(tags) && tags.some((t) => String(t).toLowerCase() === row.name.toLowerCase())) {
          const nextTags = tags.filter((t) => String(t).toLowerCase() !== row.name.toLowerCase());
          updateStmt.run(JSON.stringify(nextTags), p.id);
          affected++;
        }
      } catch {}
    }
  })();

  return { affected };
}

export function updateProfileMeta(
  database: MiniDatabase,
  id: string,
  patch: { tags?: string[]; notes?: string; trackStories?: boolean }
): SpyCard | null {
  const existing = database.db
    .prepare("SELECT id, platform, tags, notes FROM spy_profiles WHERE id = ? AND removed_at IS NULL")
    .get(id) as { id: string; platform: SpyPlatform; tags: string; notes: string } | undefined;
  if (!existing) return null;
  if (typeof patch.notes === "string" && patch.notes.length > SPY_NOTES_MAX) throw new Error("notes_too_long");
  // Stories are captured from Instagram's stories page only; Facebook was not investigated.
  if (patch.trackStories === true && existing.platform !== "instagram") throw new Error("stories_instagram_only");

  let nextTags: string[] | undefined;
  if (Array.isArray(patch.tags)) {
    nextTags = [
      ...new Set(
        patch.tags
          .map((t) => String(t).trim())
          .filter((t) => t && t.length <= 100 && !t.includes(","))
      ),
    ];
    if (nextTags.length > 0) {
      const catalog = addSpyTags(database, nextTags).tags;
      const canonical = new Map(catalog.map((t) => [t.name.toLowerCase(), t.name]));
      nextTags = [...new Set(nextTags.map((t) => canonical.get(t.toLowerCase()) ?? t))];
    }
  }

  const nextNotes = typeof patch.notes === "string" ? patch.notes : undefined;

  database.db.transaction(() => {
    if (nextTags !== undefined) {
      database.db
        .prepare("UPDATE spy_profiles SET tags = ? WHERE id = ?")
        .run(JSON.stringify(nextTags), id);
    }
    if (nextNotes !== undefined) {
      database.db
        .prepare("UPDATE spy_profiles SET notes = ? WHERE id = ?")
        .run(nextNotes, id);
    }
    if (typeof patch.trackStories === "boolean") {
      database.db
        .prepare("UPDATE spy_profiles SET track_stories = ? WHERE id = ?")
        .run(patch.trackStories ? 1 : 0, id);
    }
  })();

  return getCard(database, id);
}
