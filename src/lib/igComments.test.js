import { describe, it, expect } from "vitest";
import { buildIgExport, igExportFilename, threadComments } from "./igComments.js";

const post = {
  code: "Ddtu14nxsa1",
  meta: { username: "instagram", caption: "hi" },
  comments: [
    { cid: "2", is_reply: true, parent: "1", text: "reply" },
    { cid: "1", is_reply: false, parent: null, text: "top" },
  ],
};

describe("buildIgExport", () => {
  it("wraps the thread with the post's link and author", () => {
    const out = buildIgExport(post);
    expect(out.post_url).toBe("https://www.instagram.com/p/Ddtu14nxsa1/");
    expect(out.author).toBe("instagram");
    expect(out.count).toBe(2);
    expect(out.reply_count).toBe(1);
    expect(out.comments.map((c) => c.cid)).toEqual(["1", "2"]); // threaded: parent first
  });
});

describe("igExportFilename", () => {
  it("leads with the author and names the platform", () => {
    expect(igExportFilename("abc", "ivy.moon")).toMatch(/ivy\.moon-ig-abc-.*\.json$/);
  });
});

describe("threadComments (shared with TikTok)", () => {
  it("threads Instagram records unchanged", () => {
    expect(threadComments(post.comments).map((c) => c.cid)).toEqual(["1", "2"]);
  });
});
