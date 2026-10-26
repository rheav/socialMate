// The local stand-in for the hub's server/db.ts (~/Code/apps/socialmate-hub).
//
// The spy modules next to this file are copies of the hub's, kept as close to
// verbatim as possible so a hub fix can be carried over with a diff. They talk
// to `database.db` with the better-sqlite3 API; here that API is a thin shim
// over sql.js (SQLite compiled to WebAssembly), which runs in the extension's
// service worker and in Node for the tests.
//
// Schema: the FINAL state of every spy table and index after the hub's base
// schema plus all its MIGRATIONS (hub 0.62.0), collapsed into one DDL. Column
// order follows the hub's (base columns, then the ones migrations appended),
// because movePosts copies spy_post_observations with a positional INSERT.

import type { MediaStore } from "./spyStories.js";

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Statement {
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
  run(...params: unknown[]): RunResult;
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
}

export interface MiniDatabase {
  db: Db;
  path: string;
  close: () => void;
  /** Where the stories' media and posters live (IndexedDB Blobs, not SQLite). */
  media: MediaStore;
  /** The whole database file, for persistence. */
  export: () => Uint8Array;
  /** Rows changed since the connection opened: a request that moved it wrote something. */
  totalChanges: () => number;
}

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS spy_profiles (
    id               TEXT PRIMARY KEY,
    platform         TEXT NOT NULL,
    key              TEXT NOT NULL,
    user_id          TEXT,
    name             TEXT,
    avatar           TEXT,
    bio              TEXT,
    external_url     TEXT,
    verified         INTEGER,
    private          INTEGER,
    story_ref        TEXT,
    saved_at         INTEGER NOT NULL,
    removed_at       INTEGER,
    list_updated_at  INTEGER NOT NULL,
    meta_updated_at  INTEGER,
    last_measured_at INTEGER,
    last_error       TEXT,
    last_error_at    INTEGER,
    tags             TEXT NOT NULL DEFAULT '[]',
    notes            TEXT NOT NULL DEFAULT '',
    reels_status     TEXT NOT NULL DEFAULT 'pending',
    posts_read_at    INTEGER,
    reels_done_at    INTEGER,
    purged_at        INTEGER,
    views_read_at    INTEGER,
    track_stories    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS spy_tags (
    name       TEXT PRIMARY KEY,
    color      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS spy_snapshots (
    profile_id       TEXT NOT NULL,
    day              TEXT NOT NULL,
    measured_at      INTEGER NOT NULL,
    followers        INTEGER,
    followers_approx INTEGER NOT NULL DEFAULT 0,
    following        INTEGER,
    posts            INTEGER,
    has_story        INTEGER,
    source           TEXT NOT NULL,
    PRIMARY KEY (profile_id, day)
  );

  CREATE TABLE IF NOT EXISTS spy_reels (
    profile_id    TEXT NOT NULL,
    reel_id       TEXT NOT NULL,
    created_at    INTEGER,
    duration      REAL,
    views         INTEGER,
    first_seen_at INTEGER NOT NULL,
    thumb         TEXT,
    PRIMARY KEY (profile_id, reel_id)
  );
  CREATE INDEX IF NOT EXISTS idx_spy_reels_created ON spy_reels (profile_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS spy_posts (
    profile_id    TEXT NOT NULL,
    post_id       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    media_type    TEXT,
    pinned        INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    code          TEXT,
    views         INTEGER,
    likes         INTEGER,
    comments      INTEGER,
    thumb         TEXT,
    metrics_at    INTEGER,
    exact_date    INTEGER NOT NULL DEFAULT 1,
    duration_s    REAL,
    duration_at   INTEGER,
    views_at      INTEGER,
    likes_at      INTEGER,
    comments_at   INTEGER,
    PRIMARY KEY (profile_id, post_id)
  );
  CREATE INDEX IF NOT EXISTS idx_spy_posts_created ON spy_posts (profile_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_spy_posts_code ON spy_posts (code);

  CREATE TABLE IF NOT EXISTS spy_readings (
    profile_id  TEXT NOT NULL,
    at          INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    platform    TEXT NOT NULL,
    source      TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    error       TEXT,
    followers   INTEGER,
    reels_added INTEGER,
    pages       INTEGER,
    PRIMARY KEY (profile_id, at, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_spy_readings_at ON spy_readings (at DESC);

  CREATE TABLE IF NOT EXISTS spy_views (
    profile_id TEXT NOT NULL,
    at         INTEGER NOT NULL,
    d1         INTEGER NOT NULL,
    d3         INTEGER NOT NULL,
    d7         INTEGER NOT NULL,
    reels      INTEGER NOT NULL,
    missing    INTEGER NOT NULL,
    complete   INTEGER NOT NULL,
    PRIMARY KEY (profile_id, at)
  );

  CREATE TABLE IF NOT EXISTS spy_post_observations (
    profile_id TEXT NOT NULL, post_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL, time_source TEXT NOT NULL,
    views INTEGER, likes INTEGER, comments INTEGER, duration_s REAL,
    PRIMARY KEY (profile_id, post_id, observed_at)
  );

  CREATE TABLE IF NOT EXISTS spy_stories (
    id            TEXT PRIMARY KEY,
    profile_id    TEXT NOT NULL REFERENCES spy_profiles(id),
    reel_id       TEXT,
    media_type    INTEGER NOT NULL,
    taken_at      INTEGER NOT NULL,
    expiring_at   INTEGER NOT NULL,
    duration_ms   INTEGER,
    width         INTEGER,
    height        INTEGER,
    caption       TEXT,
    links         TEXT NOT NULL DEFAULT '[]',
    music         TEXT,
    mentions      TEXT NOT NULL DEFAULT '[]',
    ai_label      INTEGER NOT NULL DEFAULT 0,
    media_path    TEXT,
    media_bytes   INTEGER,
    media_mime    TEXT,
    poster_path   TEXT,
    captured_at   INTEGER NOT NULL,
    ready_at      INTEGER,
    starred_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS spy_stories_profile_taken ON spy_stories(profile_id, taken_at DESC);
  CREATE INDEX IF NOT EXISTS spy_stories_taken ON spy_stories(taken_at);

  CREATE TABLE IF NOT EXISTS spy_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

// ---- the better-sqlite3 shim ----

type SqlJsStatement = {
  bind(values?: unknown): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  reset(): void;
  free(): void;
};
type SqlJsDatabase = {
  prepare(sql: string): SqlJsStatement;
  run(sql: string, params?: unknown): void;
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  getRowsModified(): number;
  export(): Uint8Array;
  close(): void;
};
export type SqlJsStatic = { Database: new (data?: Uint8Array | null) => SqlJsDatabase };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);

// better-sqlite3 binds `{ id }` to @id, :id and $id alike; sql.js wants the prefix
// in the key and ignores keys the statement does not use.
function bindValues(params: unknown[]): unknown {
  if (params.length === 1 && isPlainObject(params[0])) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params[0])) {
      const value = v === undefined ? null : v;
      out[`@${k}`] = value;
      out[`:${k}`] = value;
      out[`$${k}`] = value;
    }
    return out;
  }
  // Arrays are spread, as better-sqlite3 does; undefined binds as NULL.
  return params.flat().map((v) => (v === undefined ? null : v));
}

export function wrapSqlJs(raw: SqlJsDatabase): { db: Db; resetCache: () => void; scalar: (sql: string) => number } {
  // Statements compiled once per SQL text. sql.js statements live in the wasm
  // heap and are never garbage collected: an uncached prepare per call leaks.
  const cache = new Map<string, SqlJsStatement>();
  const compiled = (sql: string) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = raw.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };
  const use = <T>(sql: string, params: unknown[], fn: (stmt: SqlJsStatement) => T): T => {
    const stmt = compiled(sql);
    try {
      stmt.bind(bindValues(params));
      return fn(stmt);
    } finally {
      stmt.reset();
    }
  };
  const scalar = (sql: string) => use(sql, [], (s) => (s.step() ? Number(s.getAsObject().v ?? 0) : 0));
  let depth = 0;
  const db: Db = {
    prepare: (sql) => ({
      get: (...params) => use(sql, params, (s) => (s.step() ? s.getAsObject() : undefined)),
      all: (...params) => use(sql, params, (s) => {
        const rows = [];
        while (s.step()) rows.push(s.getAsObject());
        return rows;
      }),
      run: (...params) => {
        use(sql, params, (s) => { while (s.step()); });
        const changes = raw.getRowsModified();
        return { changes, lastInsertRowid: scalar("SELECT last_insert_rowid() AS v") };
      },
    }),
    exec: (sql) => { raw.exec(sql); },
    // Nested calls use savepoints, as better-sqlite3 does.
    transaction: (fn) => (...args) => {
      const level = depth++;
      raw.run(level ? `SAVEPOINT tx${level}` : "BEGIN");
      try {
        const out = fn(...args);
        raw.run(level ? `RELEASE tx${level}` : "COMMIT");
        return out;
      } catch (err) {
        if (level) {
          raw.run(`ROLLBACK TO tx${level}`);
          raw.run(`RELEASE tx${level}`);
        } else {
          raw.run("ROLLBACK");
        }
        throw err;
      } finally {
        depth -= 1;
      }
    },
  };
  return {
    db,
    scalar,
    resetCache: () => {
      for (const stmt of cache.values()) {
        try { stmt.free(); } catch { /* already freed by export() */ }
      }
      cache.clear();
    },
  };
}

const NO_MEDIA: MediaStore = { remove: () => {}, key: (id, kind) => `${id}/${kind}` };

/** Opens `bytes` (or a new, empty database) with the spy schema. */
export function createDatabase(SQL: SqlJsStatic, bytes?: Uint8Array | null, media: MediaStore = NO_MEDIA): MiniDatabase {
  const raw = new SQL.Database(bytes ?? undefined);
  const { db, resetCache, scalar } = wrapSqlJs(raw);
  // better-sqlite3 turns foreign keys on; export() reopens the file and drops it.
  const pragmas = () => raw.run("PRAGMA foreign_keys = ON");
  pragmas();
  raw.exec(SCHEMA);
  return {
    db,
    path: ":local:",
    media,
    close: () => { resetCache(); raw.close(); },
    export: () => {
      // sql.js frees every statement and reopens the database to export it.
      resetCache();
      const out = raw.export();
      pragmas();
      return out;
    },
    totalChanges: () => scalar("SELECT total_changes() AS v"),
  };
}
