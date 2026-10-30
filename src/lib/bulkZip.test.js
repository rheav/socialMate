import { beforeEach, expect, it, vi } from "vitest";

const video = (id) => ({ id, username: "maker", hd_url: `https://v16.tiktokcdn.com/${id}.mp4` });
const photo = (id) => ({ id, username: "maker", images: [`https://p16.tiktokcdn.com/${id}a.jpeg?x=1`, `https://p16.tiktokcdn.com/${id}b.jpeg?x=1`] });
const adds = (sent) => sent.filter((m) => m.type === "FBW_ZIP_ADD");

let startBulkZip, sent;
const ok = async (m) => { sent.push(m); };
beforeEach(async () => {
  vi.resetModules();
  ({ startBulkZip } = await import("./bulkZip.js"));
  sent = [];
});

it("puts a video and every slide of a photo post in one ZIP", async () => {
  await startBulkZip("k", [video("1"), photo("2")], "a.zip", ok);
  expect(adds(sent).map((m) => m.filename)).toEqual(["maker-tt-1.mp4", "maker-tt-2_1.jpg", "maker-tt-2_2.jpg"]);
  expect(new Set(sent.map((m) => m.jobId)).size).toBe(1);
  expect(sent.at(-1)).toMatchObject({ type: "FBW_ZIP_FINISH", zipName: "a.zip" });
});

it("a second call stops, saves what it has, and the next run takes only the rest", async () => {
  const gate = [];
  const slow = async (m) => { sent.push(m); if (m.type === "FBW_ZIP_ADD") await new Promise((r) => gate.push(r)); };
  const run = startBulkZip("k", [video("1"), video("2"), video("3")], "a.zip", slow);
  await startBulkZip("k", [], "a.zip", slow); // the stop click
  gate.shift()();
  await run;
  expect(adds(sent).map((m) => m.filename)).toEqual(["maker-tt-1.mp4"]);
  expect(sent.at(-1).type).toBe("FBW_ZIP_FINISH");
  sent = [];
  await startBulkZip("k", [video("1"), video("2"), video("3")], "b.zip", ok);
  expect(adds(sent).map((m) => m.filename)).toEqual(["maker-tt-2.mp4", "maker-tt-3.mp4"]);
});

it("a ZIP that failed to save does not cost its reels", async () => {
  const failing = async (m) => { sent.push(m); if (m.type === "FBW_ZIP_FINISH") throw new Error("disco cheio"); };
  await startBulkZip("k", [video("1")], "a.zip", failing);
  sent = [];
  await startBulkZip("k", [video("1")], "b.zip", ok);
  expect(adds(sent)).toHaveLength(1);
});

it("a post with no media counts as failed and the run goes on", async () => {
  await startBulkZip("k", [{ id: "1", username: "maker" }, video("2")], "a.zip", ok);
  expect(adds(sent).map((m) => m.filename)).toEqual(["maker-tt-2.mp4"]);
});
