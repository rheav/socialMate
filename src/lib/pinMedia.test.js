import { describe, it, expect } from "vitest";
import {
  PWS_HANDLERS,
  surfaceOf,
  resourceGetUrl,
  resourceHeaders,
  parseEnvelope,
  boardFeedOptions,
} from "./pinMedia.js";

describe("surfaceOf", () => {
  it("detects a board", () => {
    const s = surfaceOf("https://br.pinterest.com/marianam7536/tarot/");
    expect(s.kind).toBe("board");
    expect(s.username).toBe("marianam7536");
    expect(s.slug).toBe("tarot");
    expect(s.handler).toBe(PWS_HANDLERS.board);
    expect(s.sourceUrl).toBe("/marianam7536/tarot/");
  });

  it("detects a board section", () => {
    const s = surfaceOf("https://br.pinterest.com/marianam7536/tarot/lenormand/");
    expect(s.kind).toBe("section");
    expect(s.sectionSlug).toBe("lenormand");
    expect(s.handler).toBe(PWS_HANDLERS.section);
  });

  it("detects search and keeps the query", () => {
    const s = surfaceOf("https://br.pinterest.com/search/pins/?q=tarot%20cards");
    expect(s.kind).toBe("search");
    expect(s.query).toBe("tarot cards");
    expect(s.handler).toBe(PWS_HANDLERS.search);
    expect(s.sourceUrl).toBe("/search/pins/?q=tarot%20cards");
  });

  it("treats reserved first segments as non-boards", () => {
    expect(surfaceOf("https://br.pinterest.com/pin/12345/").kind).toBe("pin");
    expect(surfaceOf("https://br.pinterest.com/today/").kind).toBe("other");
    expect(surfaceOf("https://br.pinterest.com/").kind).toBe("home");
  });

  it("treats /_saved/ and /_created/ as user pages, not boards", () => {
    expect(surfaceOf("https://br.pinterest.com/rheav7/_saved/").kind).toBe("user");
    expect(surfaceOf("https://br.pinterest.com/rheav7/").kind).toBe("user");
  });

  it("returns a stable key that changes with the surface", () => {
    const a = surfaceOf("https://br.pinterest.com/u/b/");
    const b = surfaceOf("https://br.pinterest.com/u/b/");
    const c = surfaceOf("https://br.pinterest.com/u/other/");
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });

  it("never throws on garbage", () => {
    expect(surfaceOf("not a url").kind).toBe("other");
    expect(surfaceOf(null).kind).toBe("other");
  });
});

describe("resourceGetUrl", () => {
  it("encodes source_url and the data envelope", () => {
    const u = resourceGetUrl("BoardFeedResource", { board_id: "1" }, "/a/b/", 1700000000000);
    expect(u).toContain("/resource/BoardFeedResource/get/?");
    expect(u).toContain("source_url=%2Fa%2Fb%2F");
    expect(u).toContain(encodeURIComponent(JSON.stringify({ options: { board_id: "1" }, context: {} })));
    expect(u).toContain("&_=1700000000000");
  });
});

describe("resourceHeaders", () => {
  const base = { appVersion: "d97c852", sourceUrl: "/a/b/", handler: PWS_HANDLERS.board };

  it("always sends the pws-handler — omitting it 403s", () => {
    expect(resourceHeaders(base)["x-pinterest-pws-handler"]).toBe(PWS_HANDLERS.board);
  });

  it("omits x-csrftoken for GET", () => {
    expect(resourceHeaders(base)["x-csrftoken"]).toBeUndefined();
  });

  it("includes x-csrftoken when given (POST)", () => {
    expect(resourceHeaders({ ...base, csrfToken: "abc" })["x-csrftoken"]).toBe("abc");
  });

  it("sends the app version and XHR marker", () => {
    const h = resourceHeaders(base);
    expect(h["x-app-version"]).toBe("d97c852");
    expect(h["x-requested-with"]).toBe("XMLHttpRequest");
    expect(h["x-pinterest-appstate"]).toBe("active");
    expect(h["x-pinterest-source-url"]).toBe("/a/b/");
  });
});

describe("parseEnvelope", () => {
  it("reads array data and the cursor", () => {
    const r = parseEnvelope({ resource_response: { status: "success", data: [{ id: "1" }], bookmark: "BM" } });
    expect(r.ok).toBe(true);
    expect(r.results).toEqual([{ id: "1" }]);
    expect(r.bookmark).toBe("BM");
    expect(r.isEnd).toBe(false);
  });

  it("reads search-shaped data.results", () => {
    const r = parseEnvelope({ resource_response: { status: "success", data: { results: [{ id: "2" }] }, bookmark: "-end-" } });
    expect(r.results).toEqual([{ id: "2" }]);
    expect(r.isEnd).toBe(true);
  });

  it("treats a missing bookmark as the end", () => {
    expect(parseEnvelope({ resource_response: { data: [] } }).isEnd).toBe(true);
  });

  it("surfaces an API error", () => {
    const r = parseEnvelope({ resource_response: { error: { message: "Invalid Resource Request" } } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Invalid Resource Request");
  });

  it("does not throw on null", () => {
    expect(parseEnvelope(null).ok).toBe(false);
  });
});

describe("boardFeedOptions", () => {
  const board = { id: "590745744811011892", url: "/marianam7536/tarot/" };

  it("sets filter_section_pins false — true returns only un-sectioned pins", () => {
    expect(boardFeedOptions(board, null).filter_section_pins).toBe(false);
  });

  it("omits bookmarks on the first page and wraps it in an array after", () => {
    expect(boardFeedOptions(board, null).bookmarks).toBeUndefined();
    expect(boardFeedOptions(board, "BM").bookmarks).toEqual(["BM"]);
  });

  it("carries the verified option set", () => {
    const o = boardFeedOptions(board, null);
    expect(o.board_id).toBe(board.id);
    expect(o.board_url).toBe(board.url);
    expect(o.field_set_key).toBe("react_grid_pin");
    expect(o.redux_normalize_feed).toBe(true);
    expect(o.page_size).toBe(25);
  });
});
