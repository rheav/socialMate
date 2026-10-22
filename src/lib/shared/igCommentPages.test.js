import { describe, expect, it } from "vitest";
import {
  igCommentBlock,
  igCommentGapMs,
  igCommentsPath,
  igNeedsReplies,
  igNextCommentsCursor,
  igNextRepliesPage,
  igRepliesPath,
} from "./igCommentPages.js";

// next_min_id as measured on 2026-10-22: a JSON string.
const CURSOR = '{"cached_comments_cursor":"18065024165789066","bifilter_token":"GgYY"}';

describe("igCommentPages", () => {
  it("builds the top-level and reply paths", () => {
    expect(igCommentsPath("400", null)).toBe("/api/v1/media/400/comments/?can_support_threading=true&sort_order=popular");
    expect(igCommentsPath("400", CURSOR)).toContain("&min_id=%7B%22cached_comments_cursor");
    expect(igRepliesPath("400", "181", null)).toBe("/api/v1/media/400/comments/181/child_comments/");
    expect(igRepliesPath("400", "181", { dir: "min", cursor: "AQH" })).toBe("/api/v1/media/400/comments/181/child_comments/?min_id=AQH");
    expect(igRepliesPath("400", "181", { dir: "max", cursor: "QV" })).toBe("/api/v1/media/400/comments/181/child_comments/?max_id=QV");
  });

  it("pages on the headload flag and stops at the end", () => {
    expect(igNextCommentsCursor({ next_min_id: CURSOR, has_more_comments: false, has_more_headload_comments: true })).toBe(CURSOR);
    expect(igNextCommentsCursor({ next_min_id: CURSOR, has_more_comments: false, has_more_headload_comments: false })).toBeNull();
    expect(igNextCommentsCursor({ has_more_headload_comments: true })).toBeNull();
  });

  it("asks for replies only when the preview is short", () => {
    expect(igNeedsReplies({ child_comment_count: 10, preview_child_comments: [] })).toBe(true);
    expect(igNeedsReplies({ child_comment_count: 2, preview_child_comments: [{}, {}] })).toBe(false);
    expect(igNeedsReplies({ child_comment_count: 0 })).toBe(false);
  });

  it("follows replies in either direction", () => {
    expect(igNextRepliesPage({ has_more_head_child_comments: true, next_min_child_cursor: "AQH" })).toEqual({ dir: "min", cursor: "AQH" });
    expect(igNextRepliesPage({ has_more_tail_child_comments: true, next_max_child_cursor: "QV" })).toEqual({ dir: "max", cursor: "QV" });
    expect(igNextRepliesPage({ has_more_head_child_comments: false })).toBeNull();
  });

  it("names why an answer stops the collection", () => {
    const ok = { status: 200, contentType: "application/json; charset=utf-8", body: '{"status":"ok"}' };
    expect(igCommentBlock(ok)).toBeNull();
    expect(igCommentBlock({ ...ok, status: 429 })).toBe("rate_limited");
    expect(igCommentBlock({ ...ok, status: 400, body: '{"message":"feedback_required"}' })).toBe("rate_limited");
    expect(igCommentBlock({ ...ok, status: 401 })).toBe("login");
    expect(igCommentBlock({ ...ok, redirected: true, url: "https://www.instagram.com/accounts/login/?next=x", contentType: "text/html" })).toBe("login");
    expect(igCommentBlock({ ...ok, body: '{"message":"checkpoint_required"}' })).toBe("login");
    expect(igCommentBlock({ ...ok, contentType: "text/html", body: "<html>" })).toBe("bad_response");
    expect(igCommentBlock({ ...ok, status: 500 })).toBe("http_500");
  });

  it("waits 4 to 8 seconds between requests", () => {
    expect(igCommentGapMs(() => 0)).toBe(4000);
    expect(igCommentGapMs(() => 0.999)).toBe(7996);
  });
});
