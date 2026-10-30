import { expect, it } from "vitest";
import { createZipJobs, ZIP_ABANDON_MS } from "./zipJobs.js";
import { crc32, ZIP_SIG_EOCD } from "./zipWriter.js";

const body = (n, fill) => new Uint8Array(n).fill(fill);

function setup(opts = {}) {
  const minted = [];
  const zips = createZipJobs({
    mint: (blob) => { minted.push(blob); return `blob:${minted.length}`; },
    fetchFn: async (url) => (url === "bad" ? new Response("no", { status: 403 }) : new Response(body(Number(url), 7))),
    ...opts,
  });
  return { zips, minted };
}

async function entriesOf(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(ZIP_SIG_EOCD);
  return { bytes, view, count: view.getUint16(eocd + 8, true) };
}

it("stores each file verbatim, with its CRC, in a readable archive", async () => {
  const { zips, minted } = setup();
  expect(await zips.add("j", "a.mp4", "10")).toEqual({});
  expect(await zips.add("j", "b.mp4", "20")).toEqual({});
  expect(zips.finish("j")).toEqual({ blobUrl: "blob:1", part: 1 });
  const { bytes, view, count } = await entriesOf(minted[0]);
  expect(count).toBe(2);
  expect(view.getUint32(14, true)).toBe(crc32(body(10, 7)));
  expect(new TextDecoder().decode(bytes.slice(30, 35))).toBe("a.mp4");
  expect(bytes[35]).toBe(7);
});

it("closes a part before a file would pass the limit and carries on in the next", async () => {
  const { zips, minted } = setup({ partBytes: 100 });
  expect(await zips.add("j", "a.mp4", "60")).toEqual({});
  expect(await zips.add("j", "b.mp4", "60")).toEqual({ blobUrl: "blob:1", part: 1 });
  expect(zips.finish("j")).toEqual({ blobUrl: "blob:2", part: 2 });
  expect((await entriesOf(minted[0])).count).toBe(1);
  expect((await entriesOf(minted[1])).count).toBe(1);
});

it("a failed file costs that file only, and an empty job mints nothing", async () => {
  const { zips, minted } = setup();
  await expect(zips.add("j", "x.mp4", "bad")).rejects.toThrow("HTTP 403");
  expect(zips.finish("j")).toEqual({});
  expect(minted).toEqual([]);
  await zips.add("k", "a.mp4", "5");
  await expect(zips.add("k", "x.mp4", "bad")).rejects.toThrow();
  expect(zips.finish("k").part).toBe(1);
  expect((await entriesOf(minted[0])).count).toBe(1);
});

it("keeps the document alive during a run and forgets a run nobody finished", async () => {
  let t = 0;
  const { zips } = setup({ now: () => t });
  expect(zips.active()).toBe(false);
  await zips.add("j", "a.mp4", "5");
  expect(zips.active()).toBe(true);
  t = ZIP_ABANDON_MS + 1;
  expect(zips.active()).toBe(false);
  expect(zips.finish("j")).toEqual({});
});
