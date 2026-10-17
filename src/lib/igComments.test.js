import { describe, it, expect } from "vitest";
import { buildIgExport, igExportFilename, threadComments } from "./igComments.js";
import { commentSweepTargets } from "./igComments.js";

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

describe("commentSweepTargets", () => {
  it("keeps the listed order, only posts with comments, each once, capped", () => {
    const recs = [{ code: "A", comment_count: 3 }, { code: "B", comment_count: 0 }, { code: "A", comment_count: 3 }, { code: null, comment_count: 9 }, { code: "C", comment_count: "12" }, { code: "D", comment_count: 1 }];
    expect(commentSweepTargets(recs)).toEqual(["A", "C", "D"]);
    expect(commentSweepTargets(recs, 2)).toEqual(["A", "C"]);
  });
});
