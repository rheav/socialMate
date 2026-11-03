import { describe, it, expect } from "vitest";
import { createAnalysisCollect } from "./analysisCollect.js";

// The Hub's analysis of a TikTok video (socialMate 1.31): the video's page in a small
// window of ours hands over its record; the video comes through TikTok's Referer, the
// transcript from TikTok's own captions file.
const HUB = "https://hub.example";
const VIDEO = "https://v16-webapp-prime.tiktok.com/video/hd.mp4";
const VTT_URL = "https://v16-webapp-prime.tiktok.com/caption.vtt";
const mp4 = () => { const b = new Uint8Array(64); b.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); return b; };
const stream = (chunks) => { let i = 0; return { ok: true, status: 200, headers: { get: () => null },
  body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => {} }) } }; };
const json = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });

function harness({ record, blocked = null } = {}) {
  const data = {};
  const log = { read: [], prepared: [], puts: [], evidence: [] };
  const chrome = { storage: { local: {
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (obj) => Object.assign(data, structuredClone(obj)),
  } }, tabs: {} };
  const fetchImpl = async (url, init = {}) => {
    if (url === VIDEO) return stream([mp4()]);
    if (url === VTT_URL) return { ok: true, status: 200, text: async () => "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nRepeat these affirmations\n\n00:00:02.000 --> 00:00:04.500\nfeel them deeply" };
    if (url.startsWith(`${HUB}/api/sync/analysis/assets/`)) { log.puts.push({ url, bytes: init.body.byteLength }); return json(200, {}); }
    if (url === `${HUB}/api/sync/analysis/evidence`) { log.evidence.push(JSON.parse(init.body)); return json(200, { evidenceHash: "h1" }); }
    throw new Error(`unexpected fetch ${url}`);
  };
  const api = createAnalysisCollect({
    chrome, fetchImpl, hub: async () => ({ url: HUB, token: "t" }),
    instagram: { blocked: async () => null, busy: async () => false, pause: async () => {}, serialize: (w) => w() },
    tiktok: {
      blocked: async () => blocked,
      readItem: async (url, id) => { log.read.push([url, id]); return record; },
      prepareMedia: async (url) => { log.prepared.push(url); },
    },
    sleep: async () => {}, random: () => 0,
  });
  return { api, log };
}
const task = (over = {}) => ({ taskId: "t9", leaseToken: "lease", payload: { postKey: "tiktok:7702419881362230550",
  mediaPk: "7702419881362230550", code: null, sourceUrl: "https://www.tiktok.com/@happymindmentor/video/7702419881362230550",
  assetId: "a9", reuseAssetId: null, needs: { video: true, captionFull: true, transcript: true }, ...over } });
const record = { id: "7702419881362230550", username: "happymindmentor", desc: "This is literally how I recreated my entire life",
  hd_url: VIDEO, duration: 169, width: 1080, height: 1920, subtitle: { url: VTT_URL, lang: "eng-US" } };

describe("preparing a TikTok video", () => {
  it("reads its page, uploads the video through TikTok's Referer and files TikTok's captions as the transcript", async () => {
    const { api, log } = harness({ record });
    expect(await api.preparePost(task())).toEqual({ ok: true, result: { evidenceHash: "h1" } });
    expect(log.read).toEqual([["https://www.tiktok.com/@happymindmentor/video/7702419881362230550", "7702419881362230550"]]);
    expect(log.prepared).toEqual([VIDEO, VTT_URL]);
    expect(log.puts).toEqual([{ url: `${HUB}/api/sync/analysis/assets/a9`, bytes: 64 }]);
    expect(log.evidence[0]).toMatchObject({
      taskId: "t9", authors: ["happymindmentor"], caption: { text: record.desc, full: true },
      video: { state: "available", assetId: "a9", width: 1080, height: 1920 },
      transcript: { status: "done", text: "Repeat these affirmations feel them deeply", language: "eng-US", source: "tiktok_captions",
        chunks: [{ timestamp: [0, 2], text: "Repeat these affirmations" }, { timestamp: [2, 4.5], text: "feel them deeply" }] },
    });
  });

  it("files what is missing when the page hands nothing over, and stops while TikTok is paused", async () => {
    const empty = harness({ record: null });
    expect(await empty.api.preparePost(task())).toMatchObject({ ok: true });
    expect(empty.log.evidence[0]).toMatchObject({ video: { state: "missing" } });
    expect(empty.log.evidence[0].transcript).toBeUndefined();
    const paused = harness({ record, blocked: "rate_limited" });
    expect(await paused.api.preparePost(task())).toEqual({ ok: false, code: "tiktok_paused" });
    expect(paused.log.read).toEqual([]);
  });

  it("refuses a job that is not a TikTok video page", async () => {
    const { api } = harness({ record });
    expect(await api.preparePost(task({ sourceUrl: "https://evil.example/video/1" }))).toEqual({ ok: false, code: "bad_job" });
  });
});
