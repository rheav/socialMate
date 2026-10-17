import { describe, it, expect, beforeEach } from "vitest";
import {
  IG_DELIVERY_KEY,
  IG_OUTBOX_KEY,
  IG_PENDING_LIMIT,
  createIgOutbox,
} from "./igOutbox.js";
import { enabledIgDestinations, igDestinationSettings } from "./igDestinations.js";

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
  };
}

const DESTS = {
  local: { id: "local", url: "http://localhost:3001", token: "tok-local" },
  prod: { id: "prod", url: "https://ig.example.com", token: "tok-prod" },
};

function ev(eventId, kind = "post") {
  return { eventId, kind, observedAt: "2026-10-17T10:00:00.000Z", record: { mediaPk: "1", ownerUsername: "a" } };
}

/** fetch double: per-host behaviour, records every request body. */
function fakeFetch(behaviour) {
  const calls = [];
  const impl = async (url, init) => {
    const host = new URL(url).host;
    const body = JSON.parse(init.body);
    calls.push({ url, host, body, auth: init.headers.Authorization });
    const b = behaviour[host];
    if (!b || b === "offline") throw new TypeError("Failed to fetch");
    if (typeof b === "number") return { ok: false, status: b, json: async () => ({}) };
    const result = b(body);
    return { ok: true, status: 200, json: async () => result };
  };
  impl.calls = calls;
  return impl;
}

const acceptAll = (body) => ({ acceptedIds: body.items.map((i) => i.eventId), rejected: [] });

function outboxWith(storage, fetchImpl) {
  return createIgOutbox({ storage, fetchImpl, destination: async (id) => DESTS[id] || null, now: () => 1_000 });
}

describe("igDestinations", () => {
  it("keeps only enabled destinations with an address and a token", () => {
    const s = igDestinationSettings({
      local: { enabled: true, url: "http://localhost:3001/", token: "a" },
      prod: { enabled: true, url: "https://x.example", token: "" },
    });
    expect(s.local.url).toBe("http://localhost:3001");
    expect(enabledIgDestinations(s).map((d) => d.id)).toEqual(["local"]);
  });

  it("is off by default", () => {
    expect(enabledIgDestinations(igDestinationSettings(undefined))).toEqual([]);
  });
});

describe("igOutbox", () => {
  let storage;
  beforeEach(() => {
    storage = memoryStorage();
  });

  it("A=accepted, B=offline keeps B's pending events", async () => {
    const fetchImpl = fakeFetch({ "localhost:3001": acceptAll, "ig.example.com": "offline" });
    const box = outboxWith(storage, fetchImpl);
    await box.enqueue([ev("e1"), ev("e2")], ["local", "prod"]);

    expect((await box.flush("local")).ok).toBe(true);
    const offline = await box.flush("prod");
    expect(offline.ok).toBe(false);
    expect(offline.retryable).toBe(true);

    const counts = await box.counts();
    expect(counts.local.pending).toBe(0);
    expect(counts.prod.pending).toBe(2);
    // The event bodies stay while any destination still owes them.
    expect(Object.keys(storage.data[IG_OUTBOX_KEY].events).sort()).toEqual(["e1", "e2"]);
  });

  it("resends only what was not confirmed", async () => {
    let first = true;
    const fetchImpl = fakeFetch({
      "localhost:3001": (body) => {
        if (first) {
          first = false;
          return { acceptedIds: [body.items[0].eventId], rejected: [] };
        }
        return acceptAll(body);
      },
    });
    const box = outboxWith(storage, fetchImpl);
    await box.enqueue([ev("e1"), ev("e2"), ev("e3")], ["local"]);
    await box.flush("local");
    // The first request confirmed one id and said nothing about the others:
    // they stay pending and go out in the next request, alone.
    expect(fetchImpl.calls[1].body.items.map((i) => i.eventId)).toEqual(["e2", "e3"]);
    expect((await box.counts()).local.pending).toBe(0);
    expect(storage.data[IG_OUTBOX_KEY].events).toEqual({});
  });

  it("keeps rejected events, with their code, and does not resend them", async () => {
    const fetchImpl = fakeFetch({
      "localhost:3001": (body) => ({
        acceptedIds: body.items.filter((i) => i.eventId !== "bad").map((i) => i.eventId),
        rejected: body.items.some((i) => i.eventId === "bad") ? [{ eventId: "bad", code: "invalid_media_pk" }] : [],
      }),
    });
    const box = outboxWith(storage, fetchImpl);
    await box.enqueue([ev("ok"), ev("bad")], ["local"]);
    await box.flush("local");
    await box.flush("local");
    expect(fetchImpl.calls).toHaveLength(1);
    const counts = await box.counts();
    expect(counts.local).toMatchObject({ pending: 0, rejected: 1 });
    expect(await box.rejected("local")).toEqual([{ eventId: "bad", code: "invalid_media_pk", kind: "post" }]);
  });

  it("retries post_unknown a bounded number of times", async () => {
    const fetchImpl = fakeFetch({
      "localhost:3001": (body) => ({ acceptedIds: [], rejected: body.items.map((i) => ({ eventId: i.eventId, code: "post_unknown" })) }),
    });
    const box = outboxWith(storage, fetchImpl);
    await box.enqueue([ev("c1", "comment")], ["local"]);
    for (let i = 0; i < 10; i++) await box.flush("local");
    expect(fetchImpl.calls).toHaveLength(5);
    expect((await box.counts()).local.rejected).toBe(1);
  });

  it("an event that arrives during a send stays pending", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const sent = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body.items.map((i) => i.eventId));
      await gate;
      return { ok: true, status: 200, json: async () => acceptAll(body) };
    };
    const box = outboxWith(storage, fetchImpl);
    await box.enqueue([ev("e1")], ["local"]);
    const flushing = box.flush("local");
    await new Promise((r) => setTimeout(r, 0));
    await box.enqueue([ev("late")], ["local"]);
    // A second flush of the same destination while one is running is refused.
    expect(await box.flush("local")).toMatchObject({ skipped: "busy" });
    release();
    await flushing;
    // The confirmation of the first request did not clear "late": it went out
    // in its own request and was confirmed there.
    expect(sent).toEqual([["e1"], ["late"]]);
    expect((await box.counts()).local.pending).toBe(0);
  });

  it("a restart keeps the queue and the delivery state", async () => {
    const box = outboxWith(storage, fakeFetch({ "ig.example.com": 503 }));
    await box.enqueue([ev("e1")], ["prod"]);
    await box.flush("prod");
    const reborn = outboxWith(storage, fakeFetch({ "ig.example.com": acceptAll }));
    expect((await reborn.counts()).prod.pending).toBe(1);
    expect(storage.data[IG_DELIVERY_KEY].prod).toMatchObject({ error: "HTTP 503", pending: 1 });
    await reborn.flush("prod");
    expect((await reborn.counts()).prod.pending).toBe(0);
    expect(storage.data[IG_DELIVERY_KEY].prod).toMatchObject({ error: null, lastSent: 1 });
  });

  it("a wrong token pauses the destination without dropping events", async () => {
    const box = outboxWith(storage, fakeFetch({ "localhost:3001": 401 }));
    await box.enqueue([ev("e1")], ["local"]);
    const r = await box.flush("local");
    expect(r).toMatchObject({ ok: false, retryable: false, authFailed: true });
    expect((await box.counts()).local.pending).toBe(1);
    expect(storage.data[IG_DELIVERY_KEY].local.authFailed).toBe(true);
  });

  it("past the per-destination limit it warns and keeps every pending event", async () => {
    const box = outboxWith(storage, fakeFetch({}));
    const many = Array.from({ length: IG_PENDING_LIMIT }, (_, i) => ev(`e${i}`));
    await box.enqueue(many, ["local", "prod"]);
    const prodIds = Object.keys(storage.data[IG_OUTBOX_KEY].dest.prod);
    expect(prodIds).toHaveLength(IG_PENDING_LIMIT);

    // prod is drained a little; local stays full.
    storage.data[IG_OUTBOX_KEY].dest.prod = {};
    const r = await box.enqueue([ev("over")], ["local", "prod"]);
    expect(r.full).toEqual(["local"]);
    expect(Object.keys(storage.data[IG_OUTBOX_KEY].dest.local)).toHaveLength(IG_PENDING_LIMIT);
    expect(storage.data[IG_OUTBOX_KEY].dest.local.over).toBeUndefined();
    expect(storage.data[IG_OUTBOX_KEY].dest.prod.over).toBeDefined();
    expect(storage.data[IG_DELIVERY_KEY].local.full).toBe(true);
  });

  it("sends posts before comments and transcripts, with the bearer token", async () => {
    const fetchImpl = fakeFetch({ "localhost:3001": acceptAll });
    const box = outboxWith(storage, fetchImpl);
    await box.enqueue([ev("t", "transcript"), ev("c", "comment"), ev("p", "post")], ["local"]);
    await box.flush("local");
    const [call] = fetchImpl.calls;
    expect(call.url).toBe("http://localhost:3001/ingest/socialmate");
    expect(call.auth).toBe("Bearer tok-local");
    expect(call.body.schemaVersion).toBe(1);
    expect(call.body.items.map((i) => i.eventId)).toEqual(["p", "c", "t"]);
  });

  it("re-enqueueing a confirmed id sends it again only to the destinations asked", async () => {
    const fetchImpl = fakeFetch({ "localhost:3001": acceptAll, "ig.example.com": acceptAll });
    const box = outboxWith(storage, fetchImpl);
    await box.enqueue([ev("e1")], ["local", "prod"]);
    await box.flush("local");
    await box.enqueue([ev("e1")], ["local"]);
    expect((await box.counts()).local.pending).toBe(1);
    expect((await box.counts()).prod.pending).toBe(1);
  });
});
