import { describe, it, expect } from "vitest";
import {
  parseReactions,
  parseAuthorFromAria,
  cleanAuthorUrl,
  dedupeKey,
  buildExport,
  filenameFor,
} from "./fbComments.js";

describe("parseReactions", () => {
  it("parses pt-br reactions aria-label", () => {
    expect(parseReactions("22 reações, veja quem reagiu a isso")).toBe(22);
    expect(parseReactions("1 reação")).toBe(1);
  });
  it("parses english + abbreviated", () => {
    expect(parseReactions("22 reactions")).toBe(22);
    expect(parseReactions("1,2 mil reações")).toBe(1200);
    expect(parseReactions("3K reactions")).toBe(3000);
  });
  it("returns 0 when absent / non-numeric", () => {
    expect(parseReactions(null)).toBe(0);
    expect(parseReactions("Curtir")).toBe(0);
    expect(parseReactions("")).toBe(0);
  });
});

describe("parseAuthorFromAria", () => {
  it("splits pt-br name and time", () => {
    const r = parseAuthorFromAria("Comentário de Melanie May há 4 semanas");
    expect(r.name).toBe("Melanie May");
    expect(r.time).toMatch(/4 semanas/);
  });
  it("handles english", () => {
    expect(parseAuthorFromAria("Comment by Ricky Abel 4w").name).toBe("Ricky Abel");
  });
  it("handles multi-word names and es/fr", () => {
    expect(parseAuthorFromAria("Comentario de Suzanne Catherine hace 4 semanas").name).toBe("Suzanne Catherine");
    expect(parseAuthorFromAria("Commentaire de Paula High il y a 2 jours").name).toBe("Paula High");
  });
  it("returns nulls on junk", () => {
    expect(parseAuthorFromAria(null)).toEqual({ name: null, time: null });
  });
});

describe("cleanAuthorUrl", () => {
  it("strips comment_id from a vanity profile", () => {
    const r = cleanAuthorUrl("https://www.facebook.com/melanie.may.528?comment_id=123");
    expect(r.url).toBe("https://www.facebook.com/melanie.may.528");
    expect(r.id).toBe("melanie.may.528");
  });
  it("keeps the numeric id for profile.php", () => {
    const r = cleanAuthorUrl("https://www.facebook.com/profile.php?id=100084553923293&comment_id=1");
    expect(r.url).toBe("https://www.facebook.com/profile.php?id=100084553923293");
    expect(r.id).toBe("100084553923293");
  });
  it("handles missing href", () => {
    expect(cleanAuthorUrl(null)).toEqual({ url: null, id: null });
  });
});

describe("dedupeKey", () => {
  it("uses comment_id when present", () => {
    expect(dedupeKey({ comment_id: "abc" })).toBe("abc");
  });
  it("falls back to author+text", () => {
    expect(dedupeKey({ author: { id: "u1" }, text: "hello world" })).toBe("u1|hello world");
  });
});

describe("buildExport", () => {
  it("wraps records with metadata and counts", () => {
    const recs = [
      { comment_id: "1", text: "a", is_reply: false },
      { comment_id: "2", text: "b", is_reply: true, parent_id: "1" },
    ];
    const out = buildExport({ post_url: "u", post_id: "p", sort_mode: "all" }, recs);
    expect(out.count).toBe(2);
    expect(out.reply_count).toBe(1);
    expect(out.post_id).toBe("p");
    expect(out.sort_mode).toBe("all");
    expect(out.comments).toHaveLength(2);
    expect(out.scraped_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("filenameFor", () => {
  it("files the export under social-mate/facebook/comentarios with the post id", () => {
    expect(filenameFor("123")).toMatch(
      /^social-mate\/facebook\/comentarios\/fb-123-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/,
    );
    expect(filenameFor(null)).toMatch(/fb-post-/);
  });
});
