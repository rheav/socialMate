// The Spy dashboard's API, as the hub's panel calls it — answered by the extension's
// local hub (src/hub-local/) through the service worker instead of over HTTP.
import type { PostRanking, PostMetrics, DurationSummary } from "../hub-local/shared/spy-metrics";
import type { ProfileTrends } from "../hub-local/shared/spy-trends";

// ---- spyArea ----
export type SpyPlatform = "instagram" | "facebook";

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

export interface SpyTopItem {
  id: string;
  url: string;
  createdAt: number; // s
  views: number | null;
  likes: number | null;
  comments: number | null;
  metric: "views" | "likes";
  thumbUrl: string | null;
}

/** Views of the reels published in one window before the last reading of the views. */
export interface SpyViewsWindow {
  days: number;
  views: number;
  reels: number;
  /** Reels in the window read without views. */
  missing: number;
  /** The record reaches back over the whole window. */
  complete: boolean;
}

export interface SpyViewsBlock {
  /** ms, the reading the windows end at. */
  at: number;
  /** 24 h, 3 days, 7 days. */
  windows: SpyViewsWindow[];
  /** No Reels-tab reading yet: the views the profile's grid brought, partial. */
  provisional?: boolean;
}

export interface SpyViewsReel {
  id: string;
  url: string;
  createdAt: number; // s
  views: number | null;
  thumbUrl: string | null;
}

export interface SpyViewsPoint {
  at: number;
  d1: number;
  d3: number;
  d7: number;
  reels: number;
  missing: number;
  complete: boolean;
}

export interface SpyViewsDetail {
  block: SpyViewsBlock | null;
  /** The reels of the last 16 days, newest first. */
  reels: SpyViewsReel[];
  history: SpyViewsPoint[];
  /** Level changes, spikes, returns, views per hour by age, interaction (hub 0.53). */
  trends?: ProfileTrends | null;
}

/** One of the most viewed Instagram videos of the saved profiles (top posts). */
export interface SpyTopPost extends PostMetrics {
  durationS: number | null;
  metricsAt: number | null;
  relativeViews: number | null;
  baselinePosts: number;
  id: string;
  profileId: string;
  key: string;
  name: string | null;
  avatarUrl: string | null;
  url: string;
  /** s, publication time. */
  createdAt: number;
  views: number;
  likes: number | null;
  comments: number | null;
  thumbUrl: string | null;
}

/** Top posts: five videos per period of closed days in GMT-3, and the median views per weekday and hour. */
export interface SpyTopPosts {
  ranking: PostRanking;
  minViews: number;
  windows: { days: number; from: number; to: number; items: SpyTopPost[]; duration: DurationSummary }[];
  hours: {
    from: number;
    to: number;
    videos: number;
    /** day 0 = Sunday, GMT-3; only the cells with videos. */
    cells: { day: number; hour: number; videos: number; median: number }[];
  };
  /** The reports' tag rule it read by (hub 0.49; tags [] = every profile) and the active profiles it let in. */
  profiles?: { tags: string[]; read: number; total: number };
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
  /** Other active profiles of the same account (same network user id). */
  sameAccountAs?: string[];
  /** Facebook only: reels counted so far and the first full reading's state. */
  reels?: { count: number; status: "pending" | "running" | "done"; doneAt: number | null } | null;
  /** Posts (Instagram) or reels (Facebook) per day: publication times (s) of the last days, newest first,
   *  and since when the record is complete (s; 0 = whole history; null = nothing yet). */
  daily?: { kind: "posts" | "reels"; times: number[]; since: number | null; readAt?: number | null } | null;
  /** Top 3 of the last 7 days: reels by views (Instagram falls back to likes), newest numbers. */
  top?: { items: SpyTopItem[]; complete: boolean } | null;
  /** Views of the reels of the 24 h, 3 and 7 days before the last reading of the views. */
  views?: SpyViewsBlock | null;
}

// ---- stories swipe file ----
/** `live` = still on Instagram now; `yesterday` = the closed GMT-3 day; `7d` = today and the 6 days before; `starred` = the favourites, any date. */
export type StoriesPeriod = "live" | "yesterday" | "7d" | "starred";

export interface SpyStory {
  id: string;
  profileId: string;
  /** 1 photo, 2 video. */
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

export interface SpyStoriesTrayEntry {
  profileId: string;
  count: number;
  liveCount: number;
  newestAt: number;
}

export interface SpyStoriesList {
  period: StoriesPeriod;
  now: number;
  tray: SpyStoriesTrayEntry[];
  stories: SpyStory[];
}

export interface SpyStoriesSettings {
  passesPerDay: number;
  keepDays: number;
  /** Every morning, the report of yesterday's stories (hub 0.40). */
  dailyReport: boolean;
}

export interface SpySettings {
  stories: SpyStoriesSettings;
  usage: { bytes: number; count: number; starredBytes: number; starredCount: number };
}

/** A command the hub sent to the extension over the relay ("Coletar stories"), followed in memory. */
export interface CommandState {
  requestId: string;
  command: string;
  startedAt: number;
  updatedAt: number;
  done: boolean;
  ok: boolean | null;
  error: string | null;
  progress: Record<string, unknown>;
}


/** One collection attempt reported by the extension. */
export interface SpyReading {
  profileId: string;
  platform: SpyPlatform;
  key: string;
  name: string | null;
  at: number;
  kind: "followers" | "reels" | "stories";
  source: "daily" | "visit" | "manual" | "initial" | "catchup" | "refresh" | "pass";
  ok: boolean;
  error: string | null;
  followers: number | null;
  reelsAdded: number | null;
  pages: number | null;
}

/** One kind of collection over the last 24 h, so a breakage shows without reading every line. */
export interface CollectionCheck {
  key: string;
  platform: SpyPlatform;
  kind: "followers" | "reels" | "stories" | "video" | "views";
  status: "ok" | "warn" | "broken" | "stopped";
  attempts: number;
  ok: number;
  lastOkAt: number | null;
  lastError: string | null;
}

/**
 * An HTTP failure that still carries its status. Without it a 401 read exactly
 * like a 500 at the call site, so an expired session painted "HTTP 401" over the
 * grid instead of showing the login screen again.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, code?: string) {
    super(code ? `HTTP ${status}: ${code}` : `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** One request to the local hub, through the service worker (it owns every write). */
async function local<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const res = await chrome.runtime.sendMessage({ type: "FBW_HUB_LOCAL", method, path, body: body ?? null });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!res?.ok) {
    const code = typeof res?.json?.error === "string" ? res.json.error : res?.error;
    throw new ApiError(res?.status || 500, code);
  }
  return res.json as T;
}
const json = <T>(url: string, signal?: AbortSignal) => local<T>("GET", url, undefined, signal);
const postJson = <T>(url: string, body: unknown) => local<T>("POST", url, body);
const deleteJson = <T>(url: string) => local<T>("DELETE", url);
const patchJson = <T>(url: string, body?: unknown, signal?: AbortSignal) => local<T>("PATCH", url, body, signal);

export const api = {
  spy: {
    list: (signal?: AbortSignal) =>
      json<{ profiles: SpyCard[]; total: number; max: number }>("/api/spy/profiles", signal),
    /** The saved profile's card, exactly as the list returns it. */
    add: (
      target: { url: string } | { platform: SpyPlatform; handle: string }
    ) => postJson<SpyCard>("/api/spy/profiles", target),
    /** Hidden at once; saving it again before `restorableUntil` brings its history back. */
    remove: (id: string) =>
      deleteJson<{ ok: boolean; restorableUntil?: number }>(`/api/spy/profiles/${encodeURIComponent(id)}`),
    history: (id: string, signal?: AbortSignal) =>
      json<{ profile: SpyCard; snapshots: SpySnapshot[] }>(
        `/api/spy/profiles/${encodeURIComponent(id)}/history`,
        signal
      ),
    views: (id: string, signal?: AbortSignal) =>
      json<SpyViewsDetail>(`/api/spy/profiles/${encodeURIComponent(id)}/views`, signal),
    updateProfile: (id: string, patch: { tags?: string[]; notes?: string; trackStories?: boolean }, signal?: AbortSignal) =>
      patchJson<SpyCard>(`/api/spy/profiles/${encodeURIComponent(id)}`, patch, signal),
    top: (signal?: AbortSignal, ranking: PostRanking = "views") => json<SpyTopPosts>(`/api/spy/top?ranking=${ranking}`, signal),
    stories: {
      list: (period: StoriesPeriod, profileId?: string, signal?: AbortSignal) =>
        json<SpyStoriesList>(`/api/spy/stories?period=${period}${profileId ? `&profile=${encodeURIComponent(profileId)}` : ""}`, signal),
      /** A favourite is never pruned; unstarring puts it back under the days kept. */
      star: (id: string, starred: boolean) => patchJson<{ story: SpyStory }>(`/api/spy/stories/${encodeURIComponent(id)}`, { starred }),
      /** Asks the connected extension to run a stories pass now. */
      collect: () => postJson<{ requestId: string; total: number }>("/api/spy/stories/collect", {}),
      collectStatus: (requestId: string, signal?: AbortSignal) =>
        json<{ request: CommandState }>(`/api/spy/stories/collect/${encodeURIComponent(requestId)}`, signal),
    },
    settings: {
      get: (signal?: AbortSignal) => json<SpySettings>("/api/spy/settings", signal),
      patch: (patch: { stories: Partial<SpyStoriesSettings> }) => patchJson<SpySettings>("/api/spy/settings", patch),
    },
    readings: (days = 3, signal?: AbortSignal) =>
      json<{ readings: SpyReading[] }>(`/api/spy/readings?days=${days}`, signal),
    health: (signal?: AbortSignal) => json<{ checks: CollectionCheck[] }>("/api/spy/health", signal),
    merge: (id: string, from: string) =>
      postJson<{ profile: SpyCard }>(`/api/spy/profiles/${encodeURIComponent(id)}/merge`, { from }),
    tags: {
      list: (signal?: AbortSignal) =>
        json<{ tags: { name: string; color: string; count: number }[] }>("/api/spy/tags", signal),
      add: (items: (string | { name: string; color?: string })[]) =>
        postJson<{ tags: { name: string; color: string; count: number }[] }>("/api/spy/tags", { items }),
      recolor: (name: string, color: string) =>
        patchJson<{ name: string; color: string }>(`/api/spy/tags/${encodeURIComponent(name)}`, { color }),
      rename: (from: string, to: string) =>
        patchJson<{ name: string; color: string; affected: number }>(`/api/spy/tags/${encodeURIComponent(from)}`, { name: to }),
      remove: (name: string) =>
        deleteJson<{ affected: number }>(`/api/spy/tags/${encodeURIComponent(name)}`),
    },
  },
};
