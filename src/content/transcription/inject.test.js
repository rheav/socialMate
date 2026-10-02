// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { fbSearchVideosSurface, fbCaptionFor } from "../../lib/shared/fbVideoMedia.js";
import { fbVideoRef } from "../../lib/shared/fbPermalink.js";
import { normTxLang } from "../../lib/shared/txLang.js";

// Execute the actual classic-script functions without its persistent observers,
// like the Instagram bridge tests. Only Chrome/page boundaries are supplied.
const source = readFileSync("src/content/transcription/inject.js", "utf8");
function bind(name, deps) {
  const fn = source.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`))[0];
  return new Function(...Object.keys(deps), `${fn}; return ${name};`)(...Object.values(deps));
}
afterEach(() => { document.body.innerHTML = ""; });

describe("Facebook search transcription wiring", () => {
  it("does not borrow the next feed card's permalink", () => {
    document.body.innerHTML = '<div role="feed"><div id="own"><video></video></div><div><a href="/reel/999999999">Neighbour</a></div></div>';
    const grab = bind("grabVideoRef", { fbVideoRef });
    expect(grab(document.getElementById("own"), document.querySelector("video"))).toBeNull();
  });
  it("keeps a permalink found inside the same card", () => {
    document.body.innerHTML = '<div role="feed"><div><a href="/reel/823150870841024">Own</a><video></video></div></div>';
    const grab = bind("grabVideoRef", { fbVideoRef });
    const v = document.querySelector("video");
    expect(grab(v.parentElement, v)?.id).toBe("823150870841024");
  });
  const rec = { id: "823150870841024", audio: "https://scontent.fbcdn.net/audio.mp4", progressive: "https://scontent.fbcdn.net/video.mp4",
    captions: [{ lang: "en_US", url: "https://scontent.fbcdn.net/en.srt" }] };
  function job(record = rec) {
    document.body.innerHTML = "<video></video>";
    return bind("videoJobMessage", {
      findPostUnit: v => v.parentElement,
      grabMeta: () => ({ videoId: rec.id, author: { name: "Owner" }, platform: "facebook" }),
      searchVideoFor: () => record,
      fbSearchVideosSurface, fbCaptionFor, normTxLang, txLangCache: "en",
      location: { pathname: "/search/top" },
    });
  }
  it("sends exact audio and same-language captions without duration/candidate fallbacks", async () => {
    const build = job();
    const msg = await build("transcribe", document.querySelector("video"), null, true, "en");
    expect(msg).toMatchObject({ videoId: rec.id, mediaUrl: rec.audio, captionUrl: rec.captions[0].url, language: "en", idConfident: true, feedSurface: true });
    expect(msg).not.toHaveProperty("durationHint");
    expect(msg).not.toHaveProperty("candidates");
  });
  it("uses audio instead of English captions when Portuguese is selected", async () => {
    const build = job();
    const msg = await build("transcribe", document.querySelector("video"), null, true, "br");
    expect(msg.mediaUrl).toBe(rec.audio);
    expect(msg).not.toHaveProperty("captionUrl");
  });
  it("refuses an unidentified search video instead of priming a neighbour", async () => {
    const build = job(null);
    const msg = await build("transcribe", document.querySelector("video"));
    expect(msg.captureError).toBeTruthy();
    expect(msg).not.toHaveProperty("type");
  });
  it("downloads the same video's progressive media", async () => {
    const build = job();
    expect(await build("download", document.querySelector("video"))).toMatchObject({ type: "FBW_DOWNLOAD", videoId: rec.id, mediaUrl: rec.progressive });
  });
});
