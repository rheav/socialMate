import { describe, expect, it, vi } from "vitest";

import { FONTES_BASE, sendToFontes } from "./fontes.js";

const jpeg = (type = "image/jpeg") => new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type }), { status: 200 });
const appSays = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("sendToFontes", () => {
  it("fetches the photo and posts it to the app with the header, the origin and the post link", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? jpeg() : appSays(201, [{ id: "a", duplicate: false }]); });
    const prepare = vi.fn();
    const out = await sendToFontes({ url: "https://scontent.cdninstagram.com/p.jpg", origin: "instagram", pageUrl: "https://www.instagram.com/p/ABC/" }, { fetchImpl, prepare });
    expect(out).toEqual({ ok: true, duplicate: false });
    expect(prepare).toHaveBeenCalledWith("https://scontent.cdninstagram.com/p.jpg");
    const post = calls[1];
    expect(post.url).toBe(`${FONTES_BASE}/api/flow/sources`);
    expect(post.init.headers["x-ugc-fontes"]).toBe("1");
    const file = post.init.body.get("files");
    expect([file.type, file.size, post.init.body.get("origin"), post.init.body.get("url")]).toEqual(["image/jpeg", 6, "instagram", "https://www.instagram.com/p/ABC/"]);
  });

  it("reports a photo the library already had", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jpeg()).mockResolvedValueOnce(appSays(201, [{ id: "a", duplicate: true }]));
    expect(await sendToFontes({ url: "https://x.tiktokcdn.com/p.jpeg" }, { fetchImpl })).toEqual({ ok: true, duplicate: true });
  });

  it("re-encodes what the app does not take, and only that", async () => {
    const toJpeg = vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" }));
    const fetchImpl = vi.fn().mockResolvedValueOnce(jpeg("image/avif")).mockResolvedValueOnce(appSays(201, [{}]));
    await sendToFontes({ url: "https://x.tiktokcdn.com/p.avif" }, { fetchImpl, toJpeg });
    expect(toJpeg).toHaveBeenCalledOnce();
    const again = vi.fn().mockResolvedValueOnce(jpeg("image/webp; charset=binary")).mockResolvedValueOnce(appSays(201, [{}]));
    await sendToFontes({ url: "https://x.tiktokcdn.com/p.webp" }, { fetchImpl: again, toJpeg });
    expect(toJpeg).toHaveBeenCalledOnce();
    expect(again.mock.calls[1][1].body.get("files").type).toBe("image/webp");
  });

  it("tells a closed app, a missing route and a refusal apart", async () => {
    const down = vi.fn().mockResolvedValueOnce(jpeg()).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await sendToFontes({ url: "https://a/p.jpg" }, { fetchImpl: down })).toEqual({ ok: false, error: "app" });
    const old = vi.fn().mockResolvedValueOnce(jpeg()).mockResolvedValueOnce(appSays(404, {}));
    expect((await sendToFontes({ url: "https://a/p.jpg" }, { fetchImpl: old })).error).toBe("app");
    const refused = vi.fn().mockResolvedValueOnce(jpeg()).mockResolvedValueOnce(appSays(400, { error: { message: "Só JPG, PNG ou WebP" } }));
    expect(await sendToFontes({ url: "https://a/p.jpg" }, { fetchImpl: refused })).toEqual({ ok: false, error: "server", message: "Só JPG, PNG ou WebP" });
  });

  it("refuses anything but an https photo, and a photo the CDN would not give", async () => {
    const fetchImpl = vi.fn();
    expect(await sendToFontes({ url: "blob:https://www.instagram.com/x" }, { fetchImpl })).toEqual({ ok: false, error: "url" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const denied = vi.fn().mockResolvedValueOnce(new Response("no", { status: 403 }));
    expect(await sendToFontes({ url: "https://a/p.jpg" }, { fetchImpl: denied })).toEqual({ ok: false, error: "fetch" });
  });
});
