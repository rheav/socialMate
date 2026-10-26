// Runs the hub's spy tests (~/Code/apps/socialmate-hub/tests/spy-*.test.ts)
// against the local hub. `createApp` and `request` stand in for the hub's
// createApp and supertest, so each ported test keeps its body: same input, same
// output. The hub's /api/sync/* paths map to the local /local/sync/*; there is
// no token, so `.set("X-Sync-Token", …)` is ignored.

import initSqlJs from "sql.js";

// The hub's days are fixed GMT-3; the local hub uses the browser's time zone.
// The ported expectations were written for GMT-3 (São Paulo has no DST since 2019).
process.env.TZ = "America/Sao_Paulo";
import { createLocalHub, type LocalHub, type LocalHubOptions } from "../router.ts";
import { memoryStorage } from "../storage.js";
import type { MiniDatabase } from "../server/db.js";

export const SQL = await initSqlJs();

export interface CreatedApp {
  app: LocalHub;
  database: MiniDatabase;
  storage: ReturnType<typeof memoryStorage>;
}

/** The hub's createApp(options): a fresh in-memory database; options are ignored. */
export function createApp(_options: unknown = {}, extra: Partial<LocalHubOptions> = {}): CreatedApp {
  const storage = memoryStorage();
  const app = createLocalHub({ SQL, storage, ...extra });
  return { app, database: app.openSync(), storage };
}

/** A fresh database alone (the hub's createDatabase). */
export function createDatabase(_options: unknown = {}): MiniDatabase {
  return createApp().database;
}

type Res = { status: number; body: any; blob?: Blob; headers: Record<string, string> };

class Req implements PromiseLike<Res> {
  private body: unknown;
  private type = "";
  private expected: number | null = null;
  constructor(private app: LocalHub, private method: string, private path: string) {}
  set(name: string, value = "") {
    if (name.toLowerCase() === "content-type") this.type = value;
    return this;
  }
  send(body: unknown) { this.body = body; return this; }
  expect(status: number) { this.expected = status; return this; }
  private async run(): Promise<Res> {
    // A raw upload (supertest: .set("Content-Type", …).send(buffer)) arrives as a Blob.
    const body = this.body instanceof Uint8Array ? { blob: new Blob([this.body], { type: this.type }), contentType: this.type } : this.body;
    const r = await this.app.handle(this.method, this.path.replace(/^\/api\/sync\//, "/local/sync/"), body);
    const res: Res = { status: r.status, body: r.json ?? {}, blob: r.blob, headers: r.contentType ? { "content-type": r.contentType } : {} };
    if (this.expected != null && res.status !== this.expected) {
      throw new Error(`expected ${this.expected}, got ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res;
  }
  then<A = Res, B = never>(ok?: ((v: Res) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.run().then(ok, ko);
  }
}

/** supertest's request(app): get/post/put/patch/delete → .set/.send/.expect, awaitable. */
export default function request(app: LocalHub) {
  const make = (method: string) => (path: string) => new Req(app, method, path);
  return { get: make("GET"), post: make("POST"), put: make("PUT"), patch: make("PATCH"), delete: make("DELETE") };
}
