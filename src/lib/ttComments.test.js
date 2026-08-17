import { describe, it, expect } from "vitest";
import {
  threadComments,
  sortComments,
  filterComments,
  commentToRow,
  commentCounts,
  buildExport,
  exportFilename,
} from "./ttComments.js";

const c = (o) => ({ cid: o.cid, text: o.text || "", digg_count: o.digg_count ?? null, create_time: o.create_time ?? null, username: o.username || null, nickname: o.nickname || null, is_reply: !!o.is_reply, parent: o.parent || null, reply_count: o.reply_count ?? null });

const thread = [
  c({ cid: "1", text: "top one", digg_count: 5 }),
  c({ cid: "2", text: "top two", digg_count: 50 }),
  c({ cid: "r1", text: "reply to one", digg_count: 1, is_reply: true, parent: "1" }),
  c({ cid: "r2", text: "another reply to one", digg_count: 2, is_reply: true, parent: "1" }),
];

describe("threadComments", () => {
  it("orders top-level then their replies", () => {
    const out = threadComments(thread).map((x) => x.cid);
    expect(out).toEqual(["1", "r1", "r2", "2"]);
  });
  it("keeps orphan replies (parent not captured) at the tail", () => {
    const orphan = [c({ cid: "o", is_reply: true, parent: "missing" })];
    expect(threadComments(orphan).map((x) => x.cid)).toEqual(["o"]);
  });
  it("handles empty / non-array", () => {
    expect(threadComments(null)).toEqual([]);
    expect(threadComments([])).toEqual([]);
  });
});

describe("sortComments", () => {
  it("thread mode keeps grouped order", () => {
    expect(sortComments(thread, "thread").map((x) => x.cid)).toEqual(["1", "r1", "r2", "2"]);
  });
  it("likes desc ranks flat list", () => {
    expect(sortComments(thread, "likes", "desc").map((x) => x.cid)).toEqual(["2", "1", "r2", "r1"]);
  });
  it("likes asc", () => {
    expect(sortComments(thread, "likes", "asc").map((x) => x.cid)).toEqual(["r1", "r2", "1", "2"]);
  });
  it("nulls sort last", () => {
    const list = [c({ cid: "a", digg_count: null }), c({ cid: "b", digg_count: 3 })];
    expect(sortComments(list, "likes", "desc").map((x) => x.cid)).toEqual(["b", "a"]);
  });
});

describe("filterComments", () => {
  it("matches text or author, case-insensitive", () => {
    const list = [
      c({ cid: "1", text: "This is AMAZING", username: "alice" }),
      c({ cid: "2", text: "boring", username: "bob" }),
    ];
    expect(filterComments(list, "amazing").map((x) => x.cid)).toEqual(["1"]);
    expect(filterComments(list, "BOB").map((x) => x.cid)).toEqual(["2"]);
    expect(filterComments(list, "")).toEqual(list);
  });
});

describe("commentToRow / commentCounts", () => {
  it("maps a row", () => {
    const row = commentToRow(c({ cid: "1", text: "hi", digg_count: 9, nickname: "Al", username: "alice", is_reply: true }));
    expect(row).toMatchObject({ cid: "1", text: "hi", likes: 9, author: "Al", handle: "alice", isReply: true });
  });
  it("counts top-level vs replies", () => {
    expect(commentCounts(thread)).toEqual({ total: 4, replies: 2, topLevel: 2 });
  });
});

describe("buildExport / exportFilename", () => {
  it("assembles an envelope with video url", () => {
    const video = { aweme_id: "999", meta: { username: "creator", desc: "hi" }, comments: thread };
    const ex = buildExport(video);
    expect(ex.aweme_id).toBe("999");
    expect(ex.video_url).toBe("https://www.tiktok.com/@creator/video/999");
    expect(ex.count).toBe(4);
    expect(ex.reply_count).toBe(2);
    expect(ex.comments.map((x) => x.cid)).toEqual(["1", "r1", "r2", "2"]);
  });
  it("filename includes aweme id", () => {
    expect(exportFilename("999")).toMatch(/^social-mate\/dados\/tt-999-/);
    expect(exportFilename(null)).toMatch(/tt-video-/);
  });
});
