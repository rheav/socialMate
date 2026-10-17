import { describe, it, expect } from "vitest";
import { ANALYSIS_COLLECT_KEY, ANALYSIS_MARKER, createAnalysisCollect } from "./analysisCollect.js";
import { sha256Hex } from "../lib/analysisMedia.js";

const HUB = "https://hub.example";
const CDN = (name) => `https://scontent.cdninstagram.com/v/${name}.mp4?oe=1`;
const MiB = 1024 * 1024;

/** A tiny well-formed MP4: size, 'ftyp', brand. */
function mp4(bytes = 64) {
  const b = new Uint8Array(bytes);
  b.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return b;
}

function stream(chunks, { status = 200, length = null } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-length" && length != null ? String(length) : null) },
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => {} }) },
    json: async () => ({}),
  };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });

const job = (over = {}) => ({
  taskId: "t1",
  leaseToken: "lease-1",
  payload: {
    postKey: "instagram:3003",
    mediaPk: "3003",
    code: "CCC",
    sourceUrl: "https://www.instagram.com/reel/CCC/",
    reportedComments: 3,
    assetId: "a1",
    reuseAssetId: null,
    needs: { video: true, comments: true, captionFull: true, transcript: true },
    ...over,
  },
});

const pageAnswer = (over = {}) => ({
  ok: true,
  code: "CCC",
  pk: "3003",
  url: "https://www.instagram.com/p/CCC/",
  caption: { text: "legenda inteira", full: true },
  variants: [{ w: 1080, h: 1920, url: CDN("1080") }, { w: 720, h: 1280, url: CDN("720") }],
  durationS: 41,
  mediaType: "video",
  authors: ["nasa", "partner"],
  comments: {
    items: [
      { cid: "9001", text: "que bom", username: "fa", digg_count: 2, create_time: 1, parent: null },
      { cid: "9002", text: "obrigada", username: "nasa", digg_count: 0, create_time: 2, parent: "9001" },
    ],
    stopReason: "exhausted",
    expansions: 1,
    order: "page",
    reportedTotal: 3,
  },
  ...over,
});

/**
 * Chrome, the page, the CDN and the Hub, all in memory. `page(msg, tabId)`
 * answers FBW_ANALYSIS_COLLECT; tabs keep the URL they were opened with.
 */
function world({ page = () => pageAnswer(), cdn = () => stream([mp4()]), blocked = null, busy = () => false, transcribe, uploads } = {}) {
  const data = {};
  const tabs = new Map();
  const log = { created: [], removed: [], reloaded: [], puts: [], evidence: [], cdn: [], paused: [], sent: [], transcribed: [], slept: 0 };
  let nextTab = 10;
  let clock = 1_000_000;
  const chrome = {
    storage: {
      local: {
        get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
        set: async (obj) => Object.assign(data, structuredClone(obj)),
      },
    },
    tabs: {
      create: async ({ url, active }) => {
        const id = nextTab++;
        tabs.set(id, { id, url, active });
        log.created.push({ url, active });
        return { id, url };
      },
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("no tab");
        return tabs.get(id);
      },
      remove: async (id) => {
        tabs.delete(id);
        log.removed.push(id);
      },
      reload: async (id) => log.reloaded.push(id),
      sendMessage: async (id, msg) => {
        log.sent.push(msg.type);
        if (!tabs.has(id)) throw new Error("no tab");
        if (msg.type === "FBW_PING") return { ok: true, spy: true };
        if (msg.type === "FBW_ANALYSIS_COLLECT") return page(msg, id, api);
        return { ok: true };
      },
    },
  };
  let uploadCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith("https://scontent")) {
      log.cdn.push(url);
      return cdn(url, log.cdn.length);
    }
    if (url.startsWith(`${HUB}/api/sync/analysis/assets/`)) {
      uploadCalls += 1;
      const body = init.body;
      log.puts.push({ url, headers: init.headers, bytes: body.byteLength, sha: await sha256Hex(body) });
      if (uploads) return uploads(uploadCalls, log.puts.at(-1));
      return json(200, { assetId: url.split("/").pop(), sha256: log.puts.at(-1).sha, bytes: body.byteLength });
    }
    if (url === `${HUB}/api/sync/analysis/evidence`) {
      log.evidence.push({ headers: init.headers, body: JSON.parse(init.body) });
      return json(200, { evidenceHash: "h1" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const api = createAnalysisCollect({
    chrome,
    fetchImpl,
    hub: async () => ({ url: HUB, token: "sync-token" }),
    instagram: {
      blocked: async () => blocked,
      busy: async () => busy(),
      pause: async (code) => log.paused.push(code),
      serialize: (work) => work(),
    },
    transcribe:
      transcribe ??
      (async (req) => {
        log.transcribed.push(req);
        return { status: "done", text: "olá", chunks: [{ timestamp: [0, 1.5], text: "olá" }], language: "pt", source: "whisper" };
      }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      log.slept += ms;
    },
    random: () => 0.5,
  });
  return { api, chrome, data, tabs, log, advance: (ms) => (clock += ms), now: () => clock };
}

describe("preparePost", () => {
  it("collects caption, comments, video and transcript and files them under the task's lease", async () => {
    const w = world();
    const out = await w.api.preparePost(job());
    expect(out).toEqual({ ok: true, result: { evidenceHash: "h1" } });

    expect(w.log.created).toEqual([{ url: `https://www.instagram.com/p/CCC/${ANALYSIS_MARKER}`, active: false }]);
    expect(w.log.cdn).toEqual([CDN("720")]); // the smallest 720p rendition
    const [put] = w.log.puts;
    expect(put.url).toBe(`${HUB}/api/sync/analysis/assets/a1`);
    expect(put.headers).toMatchObject({ "X-Sync-Token": "sync-token", "X-Analysis-Lease": "lease-1", "X-Content-SHA256": put.sha, "Content-Type": "video/mp4" });

    const [ev] = w.log.evidence;
    expect(ev.headers).toMatchObject({ "X-Sync-Token": "sync-token", "X-Analysis-Lease": "lease-1" });
    expect(ev.body).toMatchObject({
      taskId: "t1",
      caption: { text: "legenda inteira", full: true },
      authors: ["nasa", "partner"],
      video: { state: "available", assetId: "a1", width: 720, height: 1280 },
      transcript: { status: "done", text: "olá", language: "pt", source: "whisper" },
      comments: { reportedTotal: 3, stopReason: "exhausted", order: "page" },
    });
    expect(ev.body.comments.items).toEqual([
      { id: "9001", parentId: null, author: "fa", text: "que bom", likes: 2, createdAt: 1 },
      { id: "9002", parentId: "9001", author: "nasa", text: "obrigada", likes: 0, createdAt: 2 },
    ]);
    // The tab it opened is closed; the job is forgotten; the next post waits 20–40 s.
    expect(w.log.removed).toEqual([10]);
    const state = w.data[ANALYSIS_COLLECT_KEY];
    expect(state.taskId).toBeNull();
    expect(state.nextAt - w.now()).toBeGreaterThanOrEqual(20_000);
    expect(state.nextAt - w.now()).toBeLessThanOrEqual(40_000);
  });

  it("spaces two posts 20–40 s apart", async () => {
    const w = world();
    await w.api.preparePost(job());
    const before = w.log.slept;
    await w.api.preparePost(job({ assetId: "a2" }));
    expect(w.log.slept - before).toBeGreaterThanOrEqual(20_000);
  });

  it("reuses a staged video and the Acervo's transcript: no download, no Whisper", async () => {
    const w = world();
    await w.api.preparePost(job({ assetId: null, reuseAssetId: "a0", needs: { video: false, comments: true, captionFull: true, transcript: false } }));
    expect(w.log.cdn).toEqual([]);
    expect(w.log.puts).toEqual([]);
    expect(w.log.transcribed).toEqual([]);
    expect(w.log.evidence[0].body.video).toMatchObject({ state: "available", assetId: "a0" });
    expect(w.log.evidence[0].body.transcript).toBeUndefined();
  });

  it("an expired link gets one fresh look at the page", async () => {
    const w = world({ cdn: (_url, n) => (n === 1 ? stream([], { status: 403 }) : stream([mp4()])) });
    await w.api.preparePost(job());
    expect(w.log.reloaded).toEqual([10]);
    expect(w.log.evidence[0].body.video.state).toBe("available");
  });

  it("a second expiry leaves the video expired, and the rest still goes", async () => {
    const w = world({ cdn: () => stream([], { status: 403 }) });
    const out = await w.api.preparePost(job());
    expect(out.ok).toBe(true);
    expect(w.log.reloaded).toEqual([10]);
    expect(w.log.cdn).toHaveLength(2);
    expect(w.log.evidence[0].body.video).toMatchObject({ state: "expired", assetId: null });
    expect(w.log.evidence[0].body.comments.items).toHaveLength(2);
  });

  it("a video over 100 MiB or 10 minutes is reported, not fetched whole", async () => {
    const big = world({ cdn: () => stream([], { length: 101 * MiB }) });
    await big.api.preparePost(job());
    expect(big.log.evidence[0].body.video.state).toBe("too_large");
    expect(big.log.puts).toEqual([]);

    const long = world({ page: () => pageAnswer({ durationS: 700 }) });
    await long.api.preparePost(job());
    expect(long.log.cdn).toEqual([]);
    expect(long.log.evidence[0].body.video.state).toBe("too_large");
  });

  it("retries an upload once after a lost response", async () => {
    let calls = 0;
    const w = world({
      uploads: (n, put) => {
        calls = n;
        if (n === 1) throw new Error("socket hang up");
        return json(200, { assetId: "a1", sha256: put.sha, bytes: put.bytes });
      },
    });
    await w.api.preparePost(job());
    expect(calls).toBe(2);
    expect(w.log.puts[0].sha).toBe(w.log.puts[1].sha);
    expect(w.log.evidence[0].body.video.state).toBe("available");
  });

  it("reports a failed transcription as failed", async () => {
    const w = world({ transcribe: async () => ({ status: "error", error: "transcrição travou" }) });
    await w.api.preparePost(job());
    expect(w.log.evidence[0].body.transcript).toEqual({ status: "failed" });
  });

  it("never files another post's page as this one", async () => {
    const w = world({ page: () => ({ ok: false, error: "post_mismatch" }) });
    const out = await w.api.preparePost(job());
    expect(out.ok).toBe(true);
    const body = w.log.evidence[0].body;
    expect(body.caption).toBeUndefined();
    expect(body.comments).toBeUndefined();
    expect(body.video).toMatchObject({ state: "missing", assetId: null });
    expect(w.log.cdn).toEqual([]);
    expect(w.log.transcribed).toEqual([]);
  });

  it("a login wall or rate limit on its own tab pauses Instagram for the Spy too, and stops", async () => {
    const w = world({
      page: (_msg, tabId, api) => {
        api.onResponse({ tabId: 999, statusCode: 429, url: "https://www.instagram.com/api/x" }); // someone else's tab
        api.onResponse({ tabId, statusCode: 429, url: "https://www.instagram.com/api/graphql" });
        return pageAnswer();
      },
    });
    const out = await w.api.preparePost(job());
    expect(out).toEqual({ ok: false, code: "rate_limited" });
    expect(w.log.paused).toEqual(["rate_limited"]);
    expect(w.log.evidence).toEqual([]);
    expect(w.log.removed).toEqual([10]);

    const login = world({
      page: (_msg, tabId, api) => {
        api.onNavigation(tabId, "https://www.instagram.com/accounts/login/?next=/p/CCC/");
        return { ok: false, error: "other_page" };
      },
    });
    expect(await login.api.preparePost(job())).toEqual({ ok: false, code: "login_required" });
    expect(login.log.paused).toEqual(["login_required"]);
  });

  it("ignores errors on tabs that are not its own", async () => {
    const w = world({
      page: (_msg, _tabId, api) => {
        api.onResponse({ tabId: 999, statusCode: 429, url: "https://www.instagram.com/api/x" });
        api.onNavigation(999, "https://www.instagram.com/accounts/login/");
        return pageAnswer();
      },
    });
    expect((await w.api.preparePost(job())).ok).toBe(true);
    expect(w.log.paused).toEqual([]);
  });

  it("opens nothing while Instagram is paused", async () => {
    const w = world({ blocked: "rate_limited" });
    expect(await w.api.preparePost(job())).toEqual({ ok: false, code: "instagram_paused" });
    expect(w.log.created).toEqual([]);
  });

  it("waits for a running Spy batch, then gives up after six minutes", async () => {
    let n = 0;
    const w = world({ busy: () => ++n < 3 });
    expect((await w.api.preparePost(job())).ok).toBe(true);
    expect(w.log.created).toHaveLength(1);

    const stuck = world({ busy: () => true });
    expect(await stuck.api.preparePost(job())).toEqual({ ok: false, code: "instagram_busy" });
    expect(stuck.log.created).toEqual([]);
    expect(stuck.log.slept).toBeGreaterThanOrEqual(6 * 60_000);
  });

  it("refuses a job without a usable post id", async () => {
    const w = world();
    expect(await w.api.preparePost(job({ code: "../x", mediaPk: null }))).toEqual({ ok: false, code: "bad_job" });
    expect(w.log.created).toEqual([]);
  });
});

describe("cancelPrepare and recovery", () => {
  it("cancel stops the job and closes only the tab it opened", async () => {
    const w = world({
      page: async (_msg, _tabId, api) => {
        await api.cancelPrepare("t1");
        return pageAnswer();
      },
    });
    expect(await w.api.preparePost(job())).toEqual({ ok: false, code: "cancelled" });
    expect(w.log.removed).toEqual([10]);
    expect(w.log.sent).toContain("FBW_ANALYSIS_CANCEL");
    expect(w.log.evidence).toEqual([]);
  });

  it("leaves a tab the user took over", async () => {
    const w = world({
      page: (_msg, tabId) => {
        w.tabs.get(tabId).url = "https://www.instagram.com/someone/";
        return pageAnswer();
      },
    });
    await w.api.preparePost(job());
    expect(w.log.removed).toEqual([]);
  });

  it("after a worker restart, closes the lost job's own tab and forgets the job", async () => {
    const w = world();
    w.tabs.set(7, { id: 7, url: `https://www.instagram.com/p/CCC/${ANALYSIS_MARKER}` });
    w.tabs.set(8, { id: 8, url: "https://www.instagram.com/p/CCC/" });
    w.data[ANALYSIS_COLLECT_KEY] = { taskId: "t0", tabId: 7, startedAt: 1, nextAt: 5 };
    await w.api.recover();
    expect(w.log.removed).toEqual([7]);
    expect(w.data[ANALYSIS_COLLECT_KEY]).toMatchObject({ taskId: null, tabId: null, nextAt: 5 });

    w.data[ANALYSIS_COLLECT_KEY] = { taskId: "t0", tabId: 8, startedAt: 1, nextAt: 5 };
    await w.api.recover();
    expect(w.log.removed).toEqual([7]); // the user's tab stays
  });
});
