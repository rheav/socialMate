import { describe, it, expect } from "vitest";
import { buildIgExport, igExportFilename, threadComments, igCommentRows, toCsv, IG_COMMENT_COLS } from "./igComments.js";
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

describe("igCommentRows + toCsv", () => {
  const thread = {
    code: "Ddtu14nxsa1",
    comments: [
      { cid: "2", is_reply: true, parent: "1", text: "eu \"também\", sim", username: "b", digg_count: 2, create_time: 1791296790 },
      { cid: "1", is_reply: false, parent: null, text: "linha 1\nlinha 2", username: "a", digg_count: 1082, reply_count: 10, verified: true, create_time: 1791296790 },
    ],
  };
  it("lists each reply under its comment and names who it answers", () => {
    const rows = igCommentRows(thread);
    expect(rows.map((r) => r.id)).toEqual(["1", "2"]);
    expect(rows[0]).toMatchObject({ username: "a", likes: 1082, replies: 10, verified: "sim", reply_to: null, profile: "https://www.instagram.com/a/" });
    expect(rows[1]).toMatchObject({ reply_to: "a", parent_id: "1", replies: null });
    expect(rows[0].date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
  it("quotes commas, quotes and line breaks", () => {
    const csv = toCsv(IG_COMMENT_COLS, igCommentRows(thread));
    expect(csv.startsWith("\uFEFFUsuário,Comentário,")).toBe(true);
    expect(csv).toContain('"linha 1\nlinha 2"');
    expect(csv).toContain('"eu ""também"", sim"');
  });
  it("names the file by its format", () => {
    expect(igExportFilename("abc", "ivy.moon", "csv")).toMatch(/ivy\.moon-ig-abc-.*\.csv$/);
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
