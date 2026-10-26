import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "./harness";
import { afterEach, describe, expect, it } from "vitest";

import { createApp, type CreatedApp } from "./harness";
import { saveProfile } from "../server/spy.js";
import {
  comebackEvents, engagement, viewEvents, viewsPerHour, type ProfileTrends, type TrendEvent, type TrendPost,
} from "../shared/spy-trends.js";

// Profile signals (hub 0.53): weekly level changes, spikes that go back to
// normal, returns after a pause, views per hour by age, weighted interaction.
const DAY = 86_400;
const T0 = 1_790_000_000; // s
/** A reel `day` days after T0, its views read 10 days later (mature). */
const reel = (id: string, day: number, views: number, extra: Partial<TrendPost> = {}): TrendPost =>
  ({ id, url: `u${id}`, createdAt: T0 + day * DAY, views, viewsAt: (T0 + (day + 10) * DAY) * 1000, likes: null, comments: null, ...extra });
/** One reel a day for `days` days from `from`, all with `views`. */
const daily = (from: number, days: number, views: number) =>
  Array.from({ length: days }, (_, i) => reel(`${from + i}`, from + i, views));

describe("view events", () => {
  it("names a week whose median moved past 1.8× the two weeks before, when the next week holds it", () => {
    const events = viewEvents([...daily(0, 14, 1000), ...daily(14, 14, 3000)]);
    expect(events.map((e) => [e.kind, Math.round(e.ratio! * 10) / 10])).toEqual([["step_up", 3]]);
    expect(events[0].posts).toHaveLength(3);
  });

  it("ignores a week that the next one undoes, and flat views", () => {
    expect(viewEvents(daily(0, 28, 1000))).toEqual([]);
    expect(viewEvents([...daily(0, 14, 1000), ...daily(14, 7, 3000), ...daily(21, 7, 1000)])
      .filter((e) => e.kind.startsWith("step"))).toEqual([]);
  });

  it("calls a 10× reel followed by normal ones a spike, not one followed by more high ones", () => {
    const base = daily(0, 14, 1000);
    const spike = viewEvents([...base, reel("s", 14.5, 12_000), ...daily(15, 3, 1000)]);
    expect(spike.map((e) => [e.kind, e.posts[0].id])).toEqual([["spike", "s"]]);
    const level = viewEvents([...base, reel("s", 14.5, 12_000), ...daily(15, 3, 9000)]);
    expect(level.filter((e) => e.kind === "spike")).toEqual([]);
  });

  it("leaves out reels read before they were three days old", () => {
    const young = (r: TrendPost) => ({ ...r, viewsAt: (r.createdAt + DAY) * 1000 });
    expect(viewEvents([...daily(0, 14, 1000), ...daily(14, 14, 3000).map(young)])).toEqual([]);
  });
});

describe("returns after a pause", () => {
  it("counts a gap of 14 days or more, only where the record is complete", () => {
    const posts = [reel("a", 0, 1), reel("b", 20, 1), reel("c", 21, 1)];
    expect(comebackEvents(posts, T0).map((e) => [e.posts[0].id, e.gapDays])).toEqual([["b", 20]]);
    expect(comebackEvents(posts, T0 + 10 * DAY)).toEqual([]);
    expect(comebackEvents(posts, null)).toEqual([]);
  });
});

describe("views per hour by age", () => {
  it("takes each reel's last reading in a bucket and compares the newest reel with the others", () => {
    const posts = ["a", "b", "c", "n"].map((id, i) => ({ id, url: id, createdAt: T0 + i * DAY, views: null }));
    const at = (id: string, hours: number) => (posts.find((p) => p.id === id)!.createdAt + hours * 3600) * 1000;
    const vph = viewsPerHour(posts, [
      { id: "a", at: at("a", 5), views: 100 }, { id: "a", at: at("a", 10), views: 1000 }, // last one: 100/h
      { id: "b", at: at("b", 10), views: 2000 }, // 200/h
      { id: "c", at: at("c", 10), views: 3000 }, // 300/h
      { id: "n", at: at("n", 10), views: 4000 }, // 400/h, the newest
      { id: "a", at: at("a", 30), views: 3000 }, // the 1–3 day bucket
    ]);
    expect(vph.buckets.find((b) => b.key === "1d")).toEqual({ key: "1d", median: 250, posts: 4 });
    expect(vph.buckets.find((b) => b.key === "3d")).toEqual({ key: "3d", median: null, posts: 1 });
    expect(vph.latest).toMatchObject({ id: "n", vph: 400, bucket: "1d", ratio: 2 }); // 400 ÷ median(100, 200, 300)
  });
});

describe("weighted interaction", () => {
  it("weighs a 30-day-old post half as much as one of today and skips small or incomplete ones", () => {
    const now = (T0 + 30 * DAY) * 1000;
    const er = engagement([
      reel("old", 0, 1000, { likes: 100, comments: 0 }), // 10%, weight ½
      reel("new", 30, 1000, { likes: 40, comments: 0 }), // 4%, weight 1
      reel("small", 30, 999, { likes: 999, comments: 0 }),
      reel("nolikes", 30, 5000),
    ], now)!;
    expect(er.posts).toBe(2);
    expect(er.plain).toBeCloseTo(7);
    expect(er.weighted).toBeCloseTo((0.5 * 10 + 4) / 1.5);
  });
});

describe("profile sheet", () => {
  let dir: string;
  let created: CreatedApp;
  afterEach(() => {
    created.database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers the signals with the views detail, pinned posts left out", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "socialmate-spy-trends-"));
    created = createApp({ dbPath: path.join(dir, "test.db"), appPassword: "", syncToken: "t" });
    saveProfile(created.database, "instagram", "trend.case", 1000);
    const id = "instagram:trend.case";
    const now = Math.floor(Date.now() / 1000);
    const post = (pk: string, ageDays: number, extra = {}) =>
      ({ profileId: id, id: pk, createdAt: now - ageDays * DAY, mediaType: "video", code: `C${pk}`, views: 1000, ...extra });
    await request(created.app).post("/api/sync/spy").set("X-Sync-Token", "t").send({
      posts: [post("4001", 400, { pinned: true }), post("4002", 40), post("4003", 20), post("4004", 19)],
    });
    const body = (await request(created.app).get(`/api/spy/profiles/${encodeURIComponent(id)}/views`)).body;
    expect(body.trends.events.map((e: any) => [e.kind, e.posts[0].id, e.gapDays])).toEqual([["comeback", "4003", 20]]);
    expect(body.trends.vph.buckets).toHaveLength(4);
  });
});

describe("sinais do perfil, the sheet's section", () => {
  const nowMs = (T0 + 100 * DAY) * 1000;
  const ev = (kind: TrendEvent["kind"], day: number, extra: Partial<TrendEvent> = {}): TrendEvent =>
    ({ kind, at: T0 + day * DAY, posts: [{ id: `p${day}`, url: `https://x/${day}`, createdAt: T0 + day * DAY, views: 12_000 }], ...extra });
  const trends = (events: TrendEvent[]): ProfileTrends => ({
    events, vph: { buckets: [{ key: "1d", median: null, posts: 0 }], latest: null }, engagement: null,
  });

  // Local: the dashboard section is ported in F3 (src/dashboard), not here.
  it.skip("words each kind, drops events older than 60 days and lists five at most", () => {
    const html = renderToStaticMarkup(h(TrendsSection, { nowMs, trends: trends([
      ev("step_down", 99, { ratio: 0.03 }), ev("spike", 98, { ratio: 133.5 }), ev("comeback", 97, { gapDays: 29 }),
      ev("step_up", 96, { ratio: 4.4 }), ev("spike", 95, { ratio: 12 }), ev("spike", 94, { ratio: 11 }),
      ev("spike", 30, { ratio: 50 }),
    ]) }));
    expect(html).toContain("As views caíram de patamar");
    expect(html).toContain("mediana em 3,0% da das 2 semanas antes");
    expect(html).toContain("com 134× a mediana dos 14 dias antes");
    expect(html).toContain("Voltou a postar depois de 29 dias parado");
    expect(html).toContain("mediana 4,4× a das 2 semanas antes");
    expect(html).toContain("e mais 1 nos últimos 60 dias.");
    expect(html).not.toContain("50×");
    expect(html).not.toContain("Views por hora"); // no reel read at any age yet
  });

  it.skip("says so when nothing happened, and draws nothing without the field", () => {
    expect(renderToStaticMarkup(h(TrendsSection, { nowMs, trends: trends([]) }))).toContain("Nenhuma mudança de patamar");
    expect(renderToStaticMarkup(h(TrendsSection, { nowMs, trends: undefined }))).toBe("");
  });
});
