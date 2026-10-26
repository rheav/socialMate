// The hub, in process. `handle(method, path, body)` answers like the hub's HTTP
// routes (~/Code/apps/socialmate-hub server/sync.ts and server/app.ts), over the
// copied server modules and a sql.js database persisted to IndexedDB. Used by
// the PUBLIC build only, where there is no server.
//
// Two groups of routes:
//  - the extension's sync contract, at /local/sync/spy/* (the hub: /api/sync/spy/*;
//    renamed so the public bundle carries no hub address). No token.
//  - the dashboard's Spy routes, at /api/spy/*, same JSON as the hub. What only
//    exists for the hub's AI reports, login, backup and relay is not here.
//
// Images: the hub answers avatar and thumbnail PATHS
// (/api/spy/profiles/:id/avatar, .../media/:mid/thumb) that its own routes serve.
// Here those paths are replaced, in every JSON answer, by the data: URL stored in
// SQLite. Story media is not in the JSON (the hub's panel builds the URL itself);
// extension pages read it with readStoryMedia (./media.js), and the dashboard
// refers to it as `local-story:<id>/<kind>` (kind "media" | "poster").
//
// Every request runs alone, in arrival order: a write never interleaves with
// another request. After a request that changed a row, the whole database is
// exported and saved (sql.js keeps it in memory), then the story media its rows
// dropped are deleted.

import { serialQueue } from "../lib/serialQueue.js";
import { createDatabase, type MiniDatabase, type SqlJsStatic } from "./server/db.js";
import {
  SPY_MAX_ACTIVE,
  SPY_REMOVED_KEEP_MS,
  addSpyTags,
  applyListOps,
  deleteSpyTag,
  getCard,
  getHistory,
  ingestErrors,
  ingestProfiles,
  ingestSnapshots,
  listCards,
  listForExtension,
  listSpyTags,
  mergeProfiles,
  parseProfileUrl,
  purgeRemoved,
  recolorSpyTag,
  removeProfile,
  renameSpyTag,
  saveProfile,
  updateProfileMeta,
} from "./server/spy.js";
import { collectionHealth, ingestReadings, ingestReels, ingestReelsStatus, listReadings, refreshReelPosts } from "./server/spyReels.js";
import { activeTopBlocks, ingestPosts, ingestThumbs, pruneThumbs, type TopBlock } from "./server/spyPosts.js";
import { recordViews, viewsDetail } from "./server/spyViews.js";
import { topPosts } from "./server/spyTopPosts.js";
import { reportTagsOf } from "./server/analysis/reportTags.js";
import {
  STORIES_PERIODS,
  StoryError,
  acceptStoryBlob,
  ingestStories,
  listStories,
  orphanMediaKeys,
  pruneStories,
  readStoriesSettings,
  setStoryStarred,
  storiesUsage,
  storyFile,
  trackedProfileIds,
  updateStoriesSettings,
  type MediaStore,
  type StoriesPeriod,
} from "./server/spyStories.js";

/** Where the database file and the story media are kept (IndexedDB in the extension). */
export interface LocalStorage {
  load(): Promise<Uint8Array | null | undefined>;
  save(bytes: Uint8Array): Promise<void>;
  putMedia(key: string, blob: Blob): Promise<void>;
  getMedia(key: string): Promise<Blob | null | undefined>;
  deleteMedia(keys: string[]): Promise<void>;
  mediaKeys(): Promise<string[]>;
}

export interface CommandReply {
  progress(fields: Record<string, unknown>): void;
  result(ok: boolean, fields?: Record<string, unknown>): void;
}

export interface LocalHubOptions {
  SQL: SqlJsStatic;
  storage: LocalStorage;
  /** "Coletar stories": the extension's stories pass (the hub sends `stories.collect` over its relay). */
  collectStories?: (msg: { profileIds: string[] }, reply: CommandReply) => unknown;
  now?: () => number;
}

export interface LocalResponse {
  status: number;
  json?: unknown;
  blob?: Blob;
  contentType?: string;
}

/**
 * Observations are the only spy table the hub never prunes. 97 days is the
 * longest window anything reads (the top posts' 90-day hours map plus a week).
 */
export const OBSERVATIONS_KEEP_MS = 97 * 86_400_000;
/** The hub's relay ends a command with no news for this long (extension_timeout). */
const COMMAND_TIMEOUT_MS = 120_000;

export function createLocalHub(options: LocalHubOptions) {
  const { SQL, storage } = options;
  const now = options.now ?? Date.now;
  const queue = serialQueue();
  const doomed: string[] = [];
  const media: MediaStore = {
    key: (id, kind) => `${id}/${kind}`,
    remove: (keys) => { doomed.push(...keys); },
    put: (key, blob) => storage.putMedia(key, blob),
    size: async (key) => (await storage.getMedia(key))?.size ?? null,
  };
  let database: MiniDatabase | null = null;
  let dirty = false;

  async function open(): Promise<MiniDatabase> {
    if (!database) {
      const bytes = (await storage.load()) ?? null;
      if (!database) openSync(bytes);
    }
    return database!;
  }

  /** Opens the database from `bytes` now (tests use it to seed before the first request). */
  function openSync(bytes: Uint8Array | null = null): MiniDatabase {
    if (!database) {
      database = createDatabase(SQL, bytes, media);
      // The hub purges on boot; the first request saves it.
      if (purgeRemoved(database, now())) dirty = true;
    }
    return database;
  }

  /** Runs `work` alone, then saves what it changed. */
  function exclusive<T>(work: (db: MiniDatabase) => T | Promise<T>): Promise<T> {
    return queue(async () => {
      const db = await open();
      const before = db.totalChanges();
      try {
        return await work(db);
      } finally {
        if (db.totalChanges() !== before) dirty = true;
        // A failed save leaves `dirty` set: the next request tries again.
        if (dirty) {
          await storage.save(db.export());
          dirty = false;
        }
        if (doomed.length) await storage.deleteMedia(doomed.splice(0));
      }
    });
  }

  // ---- "Coletar stories" (the hub's relay command state, in memory) ----
  type CommandState = {
    requestId: string; command: string; startedAt: number; updatedAt: number;
    done: boolean; ok: boolean | null; error: string | null; progress: Record<string, unknown>;
  };
  let command: CommandState | null = null;
  const activeCommand = () => {
    if (command && !command.done && now() - command.updatedAt > COMMAND_TIMEOUT_MS) {
      Object.assign(command, { done: true, ok: false, error: "extension_timeout", updatedAt: now() });
    }
    return command && !command.done ? command : null;
  };
  function startCollect(profileIds: string[]): CommandState {
    const at = now();
    const state: CommandState = {
      requestId: `local-${at}-${Math.random().toString(36).slice(2, 8)}`,
      command: "stories.collect", startedAt: at, updatedAt: at, done: false, ok: null, error: null, progress: {},
    };
    const merge = (fields: Record<string, unknown> = {}) => {
      for (const [key, value] of Object.entries(fields)) if (key !== "ok" && key !== "error") state.progress[key] = value;
      state.updatedAt = now();
    };
    const reply: CommandReply = {
      progress: (fields) => { if (!state.done) merge(fields); },
      result: (ok, fields = {}) => {
        if (state.done) return;
        merge(fields);
        state.done = true;
        state.ok = ok === true;
        state.error = state.ok ? null : typeof fields.error === "string" ? fields.error : "failed";
      },
    };
    command = state;
    // Outside the queue: the pass sends its readings back through this hub.
    setTimeout(() => {
      Promise.resolve()
        .then(() => options.collectStories!({ profileIds }, reply))
        .catch(() => reply.result(false, { error: "command_failed" }));
    }, 0);
    return state;
  }

  // ---- routes ----

  const ok = (json: unknown, status = 200): LocalResponse => ({ status, json });
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LocalResponse =>
    ({ status, json: { error, ...extra } });
  const asArray = (v: unknown) => (Array.isArray(v) ? v : null);

  async function route(db: MiniDatabase, method: string, path: string, rawBody: unknown): Promise<LocalResponse> {
    const url = new URL(path, "http://local");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const query = url.searchParams;
    const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, any>;
    const at = (i: number) => parts[i] ?? "";
    const is = (m: string, ...segments: (string | null)[]) =>
      method === m && parts.length === segments.length && segments.every((s, i) => s === null || s === parts[i]);

    // -- the extension's sync contract (hub: server/sync.ts) --
    if (is("GET", "local", "sync", "spy", "profiles")) {
      return ok({ ok: true, serverTime: now(), max: SPY_MAX_ACTIVE, profiles: listForExtension(db),
        settings: { stories: readStoriesSettings(db) } });
    }
    if (is("POST", "local", "sync", "spy")) return postSpy(db, body);
    if (is("PUT", "local", "sync", "spy", "stories", null, null) && (at(5) === "media" || at(5) === "poster")) {
      const blob = toBlob(body.blob ?? body.body, body.contentType);
      if (!blob) return fail(400, "upload_failed");
      try {
        return ok(await acceptStoryBlob(db, media, at(4), at(5) as "media" | "poster", blob,
          { contentType: String(body.contentType ?? blob.type ?? "") }));
      } catch (e) {
        const err = e instanceof StoryError ? e : new StoryError(500, "upload_failed");
        return fail(err.status, err.code);
      }
    }

    // -- the dashboard's Spy routes (hub: server/app.ts) --
    if (is("GET", "api", "spy", "profiles")) {
      purgeRemoved(db, now());
      const items = listCards(db);
      return ok({ profiles: items, total: items.length, max: SPY_MAX_ACTIVE });
    }
    if (is("POST", "api", "spy", "profiles")) {
      const url = typeof body.url === "string" ? body.url : null;
      const platform = typeof body.platform === "string" ? body.platform : null;
      const handle = typeof body.handle === "string" ? body.handle : null;
      const target = url ? parseProfileUrl(url) : platform && handle ? parseProfileUrl(handle, platform) : null;
      if (!target) return fail(400, "invalid_profile");
      try {
        const result = saveProfile(db, target.platform, target.key, now());
        return ok(getCard(db, result.id), result.status === "created" ? 201 : 200);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "limit_reached") return fail(409, "limit_reached");
        if (msg === "invalid_profile") return fail(400, "invalid_profile");
        throw err;
      }
    }
    if (is("DELETE", "api", "spy", "profiles", null)) {
      const t = now();
      if (!removeProfile(db, at(3), t)) return fail(404, "not_found");
      return ok({ ok: true, restorableUntil: t + SPY_REMOVED_KEEP_MS });
    }
    if (is("PATCH", "api", "spy", "profiles", null)) {
      const patch: { tags?: string[]; notes?: string; trackStories?: boolean } = {};
      if (Array.isArray(body.tags)) patch.tags = body.tags;
      if (typeof body.notes === "string") patch.notes = body.notes;
      if (typeof body.trackStories === "boolean") patch.trackStories = body.trackStories;
      let updated;
      try {
        updated = updateProfileMeta(db, at(3), patch);
      } catch (error) {
        if (error instanceof Error && (error.message === "notes_too_long" || error.message === "stories_instagram_only")) {
          return fail(400, error.message);
        }
        throw error;
      }
      return updated ? ok(updated) : fail(404, "not_found");
    }
    if (is("GET", "api", "spy", "profiles", null, "history")) {
      const history = getHistory(db, at(3));
      return history ? ok(history) : fail(404, "not_found");
    }
    if (is("GET", "api", "spy", "profiles", null, "views")) {
      const detail = viewsDetail(db, at(3), now());
      return detail ? ok(detail) : fail(404, "not_found");
    }
    if (is("POST", "api", "spy", "profiles", null, "merge")) {
      const from = typeof body.from === "string" ? body.from : "";
      try {
        return ok({ profile: mergeProfiles(db, at(3), from, now()) });
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const status = code === "invalid" ? 400 : code === "not_found" ? 404 : code === "different_account" ? 409 : 0;
        if (!status) throw error;
        return fail(status, code);
      }
    }
    if (is("GET", "api", "spy", "readings")) return ok({ readings: listReadings(db, Number(query.get("days") ?? 3), now()) });
    if (is("GET", "api", "spy", "health")) return ok({ checks: collectionHealth(db, now()) });

    if (is("GET", "api", "spy", "stories")) {
      const period = String(query.get("period") ?? "live") as StoriesPeriod;
      if (!STORIES_PERIODS.includes(period)) return fail(400, "bad_period");
      const t = now();
      const profile = query.get("profile") || undefined;
      return ok({ period, now: t, ...listStories(db, period, t, profile) });
    }
    if (is("PATCH", "api", "spy", "stories", null)) {
      if (typeof body.starred !== "boolean") return fail(400, "bad_starred");
      const story = setStoryStarred(db, at(3), body.starred, now());
      return story ? ok({ story }) : fail(404, "not_found");
    }
    if (is("POST", "api", "spy", "stories", "collect")) {
      const profileIds = trackedProfileIds(db);
      if (!profileIds.length) return fail(400, "nothing_tracked");
      const alive = activeCommand();
      if (alive) return fail(409, "already_collecting", { requestId: alive.requestId });
      if (!options.collectStories) return fail(409, "extension_offline");
      const state = startCollect(profileIds);
      return ok({ requestId: state.requestId, total: profileIds.length }, 202);
    }
    if (is("GET", "api", "spy", "stories", "collect", null)) {
      activeCommand();
      return command && command.requestId === at(4) ? ok({ request: { ...command, progress: { ...command.progress } } }) : fail(404, "not_found");
    }
    if (is("GET", "api", "spy", "stories", null, null) && (at(4) === "media" || at(4) === "poster")) {
      // In process only: a Blob does not survive runtime messaging (pages use readStoryMedia).
      const file = storyFile(db, media, at(3), at(4) as "media" | "poster");
      const blob = file ? await storage.getMedia(file.key) : null;
      return file && blob ? { status: 200, blob, contentType: file.contentType } : fail(404, "not_found");
    }

    if (is("GET", "api", "spy", "settings")) return ok({ stories: readStoriesSettings(db), usage: storiesUsage(db) });
    if (is("PATCH", "api", "spy", "settings")) {
      const patch = body.stories;
      if (!patch || typeof patch !== "object") return fail(400, "invalid_settings");
      try {
        return ok({ stories: updateStoriesSettings(db, patch, now()), usage: storiesUsage(db) });
      } catch (error) {
        if (error instanceof Error && error.message === "invalid_settings") return fail(400, "invalid_settings");
        throw error;
      }
    }
    if (is("GET", "api", "spy", "top")) {
      const r = query.get("ranking");
      const ranking = r === "engagement" || r === "comments" ? r : "views";
      return ok(topPosts(db, now(), ranking, reportTagsOf(db)));
    }

    if (is("GET", "api", "spy", "tags")) return ok(listSpyTags(db));
    if (is("POST", "api", "spy", "tags")) {
      const items = asArray(body.items) ?? asArray(body.names) ?? asArray(body.values) ?? (body.name ? [body] : []);
      if (!items.length) return fail(400, "tag_required");
      return ok(addSpyTags(db, items), 201);
    }
    if (is("PATCH", "api", "spy", "tags", null)) {
      const { color, name: nextName } = body;
      try {
        if (typeof color === "string") return ok(recolorSpyTag(db, at(3), color));
        if (typeof nextName === "string") return ok(renameSpyTag(db, at(3), nextName));
        return fail(400, "invalid_patch");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(msg === "tag_not_found" ? 404 : 400, msg);
      }
    }
    if (is("DELETE", "api", "spy", "tags", null)) {
      try {
        return ok(deleteSpyTag(db, at(3)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(msg === "tag_not_found" ? 404 : msg === "tag_in_report_rule" ? 409 : 400, msg);
      }
    }
    return fail(404, "not_found");
  }

  /** The hub's POST /api/sync/spy, in the same order. */
  function postSpy(database: MiniDatabase, body: Record<string, unknown>): LocalResponse {
    const hasOps = Array.isArray(body.ops);
    const hasProfiles = Array.isArray(body.profiles);
    const hasSnapshots = Array.isArray(body.snapshots);
    const hasErrors = Array.isArray(body.errors);
    const hasReels = Array.isArray(body.reels);
    const hasReelsStatus = Array.isArray(body.reelsStatus);
    const hasReadings = Array.isArray(body.readings);
    const hasPosts = Array.isArray(body.posts);
    const hasThumbs = Array.isArray(body.thumbs);
    const hasStories = Array.isArray(body.stories);

    if (!hasOps && !hasProfiles && !hasSnapshots && !hasErrors && !hasReels && !hasReelsStatus && !hasReadings && !hasPosts && !hasThumbs && !hasStories) {
      return fail(400, "empty_batch");
    }

    const t = now();
    const results: Record<string, unknown> = {};
    let top: Map<string, TopBlock> | undefined;

    const runBatch = database.db.transaction(() => {
      if (hasOps) results.ops = applyListOps(database, body.ops as unknown[], t);
      if (hasProfiles) results.profiles = ingestProfiles(database, body.profiles as unknown[]);
      if (hasSnapshots) results.snapshots = ingestSnapshots(database, body.snapshots as unknown[], t);
      if (hasErrors) results.errors = ingestErrors(database, body.errors as unknown[]);
      if (hasReels) results.reels = ingestReels(database, body.reels as unknown[], t);
      if (hasReelsStatus) results.reelsStatus = ingestReelsStatus(database, body.reelsStatus as unknown[]);
      const viewsRead = new Set<string>();
      if (hasReadings) results.readings = ingestReadings(database, body.readings as unknown[], t, viewsRead);
      if (hasPosts) results.posts = ingestPosts(database, body.posts as unknown[], t);
      if (hasThumbs) results.thumbs = ingestThumbs(database, body.thumbs as unknown[]);
      if (hasStories) results.stories = ingestStories(database, body.stories as unknown[], t);
      if (hasPosts || hasReels || hasThumbs) {
        top = activeTopBlocks(database, t);
        pruneThumbs(database, t, top);
      }
      const profileIds = (list: unknown) => (Array.isArray(list) ? list : [])
        .map((item) => (item as { profileId?: unknown })?.profileId).filter((id): id is string => typeof id === "string");
      recordViews(database, viewsRead, [...profileIds(body.posts), ...profileIds(body.reels)], t);
      if (hasSnapshots) {
        refreshReelPosts(database, new Set((body.snapshots as { profileId?: unknown }[])
          .map((snap) => snap?.profileId).filter((id): id is string => typeof id === "string")));
      }
    });

    runBatch();
    purgeRemoved(database, t);
    if (hasStories) pruneStories(database, media, t);

    return ok({
      ok: true,
      results,
      serverTime: t,
      max: SPY_MAX_ACTIVE,
      profiles: listForExtension(database, top),
      settings: { stories: readStoriesSettings(database) },
    });
  }

  // ---- images: the hub's paths → the stored data: URLs ----

  const AVATAR_PATH = /^\/api\/spy\/profiles\/([^/?]+)\/avatar(?:\?|$)/;
  const THUMB_PATH = /^\/api\/spy\/profiles\/([^/?]+)\/media\/([^/?]+)\/thumb$/;

  function withImages(db: MiniDatabase, value: unknown): unknown {
    const seen = new Map<string, string | null>();
    const lookup = (path: string): string | null => {
      if (seen.has(path)) return seen.get(path)!;
      let found: string | null = null;
      const avatar = AVATAR_PATH.exec(path);
      const thumb = avatar ? null : THUMB_PATH.exec(path);
      if (avatar) {
        found = (db.db.prepare("SELECT avatar FROM spy_profiles WHERE id = ?").get(decodeURIComponent(avatar[1])) as
          { avatar: string | null } | undefined)?.avatar ?? null;
      } else if (thumb) {
        const rows = db.db.prepare(`
          SELECT thumb FROM spy_posts WHERE profile_id = @p AND post_id = @m
          UNION ALL SELECT thumb FROM spy_reels WHERE profile_id = @p AND reel_id = @m
        `).all({ p: decodeURIComponent(thumb[1]), m: decodeURIComponent(thumb[2]) }) as { thumb: string | null }[];
        found = rows.find((r) => r.thumb)?.thumb ?? null;
      }
      seen.set(path, found);
      return found;
    };
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return v.startsWith("/api/spy/profiles/") && (AVATAR_PATH.test(v) || THUMB_PATH.test(v)) ? lookup(v) : v;
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) out[k] = walk(x);
        return out;
      }
      return v;
    };
    return walk(value);
  }

  /**
   * One request. JSON answers go through JSON, as over HTTP: no `undefined`
   * fields, fresh objects. Unknown errors answer 500, as Express would.
   */
  function handle(method: string, path: string, body?: unknown): Promise<LocalResponse> {
    return exclusive(async (db) => {
      let res: LocalResponse;
      try {
        res = await route(db, String(method).toUpperCase(), path, body);
      } catch (err) {
        res = fail(500, err instanceof Error ? err.message : String(err));
      }
      return res.json === undefined ? res : { ...res, json: JSON.parse(JSON.stringify(withImages(db, res.json))) };
    });
  }

  /**
   * The hourly upkeep (chrome.alarms): removed profiles past the undo window,
   * expired stories, observations past 97 days, and stored media no row names.
   */
  function prune(): Promise<{ purged: number; observations: number; stories: ReturnType<typeof pruneStories>; orphans: number }> {
    return exclusive(async (db) => {
      const t = now();
      const purged = purgeRemoved(db, t);
      const stories = pruneStories(db, media, t);
      const observations = db.db.prepare("DELETE FROM spy_post_observations WHERE observed_at < ?").run(t - OBSERVATIONS_KEEP_MS).changes;
      const orphans = orphanMediaKeys(db, await storage.mediaKeys()).filter((key) => !doomed.includes(key));
      media.remove(orphans);
      return { purged, observations, stories, orphans: orphans.length };
    });
  }

  return {
    handle,
    prune,
    openSync,
  };
}

export type LocalHub = ReturnType<typeof createLocalHub>;

function toBlob(value: unknown, type: unknown): Blob | null {
  const mime = typeof type === "string" ? type : "";
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return new Blob([value as BlobPart], { type: mime });
  return null;
}
