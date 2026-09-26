import { describe, it, expect } from "vitest";
import {
  emptyQuery,
  normalizeQuery,
  matchesFilter,
  applyQuery,
  primarySort,
  withPrimarySort,
  querySignature,
} from "./feedQuery.js";

// A tiny field map standing in for the per-platform ones (igQuery / ttQuery).
const FIELDS = {
  views: { kind: "number", get: (r) => r.views },
  likes: { kind: "number", get: (r) => r.likes },
  rate: { kind: "number", get: (r, ctx) => (r.views ? (r.likes / r.views) * 100 * (ctx.boost || 1) : null) },
  caption: { kind: "text", get: (r) => r.caption },
  tags: { kind: "text", get: (r) => r.tags },
  type: { kind: "enum", values: ["video", "photo"], get: (r) => r.type },
  date: { kind: "date", get: (r) => r.date },
};

const R = [
  { id: "a", views: 100, likes: 10, caption: "Tarot do dia", tags: ["tarot"], type: "video", date: 50 },
  { id: "b", views: 900, likes: 9, caption: "Signos", tags: ["astro"], type: "photo", date: 30 },
  { id: "c", views: null, likes: 50, caption: null, tags: [], type: "video", date: 10 },
  { id: "d", views: 900, likes: 90, caption: "Tarot amor", tags: ["tarot", "amor"], type: "video", date: 20 },
];
const ids = (rs) => rs.map((r) => r.id);

describe("emptyQuery", () => {
  it("is a no-op query: capture order, nothing hidden", () => {
    expect(ids(applyQuery(R, emptyQuery(), FIELDS))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("multi-sort", () => {
  it("sorts by the first key, then breaks ties with the next", () => {
    const q = { ...emptyQuery(), sorts: [{ key: "views", dir: "desc" }, { key: "likes", dir: "desc" }] };
    expect(ids(applyQuery(R, q, FIELDS))).toEqual(["d", "b", "a", "c"]);
  });

  it("puts a missing value last in either direction", () => {
    const asc = { ...emptyQuery(), sorts: [{ key: "views", dir: "asc" }] };
    expect(ids(applyQuery(R, asc, FIELDS)).at(-1)).toBe("c");
    const desc = { ...emptyQuery(), sorts: [{ key: "views", dir: "desc" }] };
    expect(ids(applyQuery(R, desc, FIELDS)).at(-1)).toBe("c");
  });

  it("keeps capture order for a full tie (stable)", () => {
    const q = { ...emptyQuery(), sorts: [{ key: "views", dir: "desc" }] };
    expect(ids(applyQuery(R, q, FIELDS)).slice(0, 2)).toEqual(["b", "d"]);
  });

  it("passes the context (ER weights) through to derived fields", () => {
    const q = { ...emptyQuery(), sorts: [{ key: "rate", dir: "desc" }] };
    expect(ids(applyQuery(R, q, FIELDS, { boost: 2 }))).toEqual(["a", "d", "b", "c"]);
  });
});

describe("filters", () => {
  const f = (field, op, value, valueTo) => ({ field, op, value, valueTo });

  it("compares numbers", () => {
    expect(matchesFilter(R[1], f("views", "gt", 500), FIELDS)).toBe(true);
    expect(matchesFilter(R[0], f("views", "gte", 100), FIELDS)).toBe(true);
    expect(matchesFilter(R[0], f("views", "lt", 100), FIELDS)).toBe(false);
    expect(matchesFilter(R[0], f("views", "between", 50, 150), FIELDS)).toBe(true);
    expect(matchesFilter(R[1], f("views", "between", 50, 150), FIELDS)).toBe(false);
  });

  it("treats a record without the value as not matching a numeric rule", () => {
    expect(matchesFilter(R[2], f("views", "gt", 0), FIELDS)).toBe(false);
  });

  it("matches text case-insensitively, arrays included", () => {
    expect(matchesFilter(R[0], f("caption", "contains", "TAROT"), FIELDS)).toBe(true);
    expect(matchesFilter(R[1], f("caption", "notContains", "tarot"), FIELDS)).toBe(true);
    expect(matchesFilter(R[3], f("tags", "contains", "amor"), FIELDS)).toBe(true);
  });

  it("matches an enum against a list", () => {
    expect(matchesFilter(R[1], f("type", "isAnyOf", ["photo"]), FIELDS)).toBe(true);
    expect(matchesFilter(R[0], f("type", "isAnyOf", ["photo"]), FIELDS)).toBe(false);
  });

  it("notEmpty asks only whether the field has a value", () => {
    expect(matchesFilter(R[2], f("views", "notEmpty"), FIELDS)).toBe(false);
    expect(matchesFilter(R[2], f("tags", "notEmpty"), FIELDS)).toBe(false);
    expect(matchesFilter(R[0], f("tags", "notEmpty"), FIELDS)).toBe(true);
  });

  it("ignores a rule that is still being typed instead of hiding everything", () => {
    expect(matchesFilter(R[2], f("views", "gt", ""), FIELDS)).toBe(true);
    expect(matchesFilter(R[2], f("views", "between", 1, ""), FIELDS)).toBe(true);
  });

  it("joins rules with E (all) or OU (any)", () => {
    const rules = [f("views", "gte", 900), f("caption", "contains", "tarot")];
    expect(ids(applyQuery(R, { ...emptyQuery(), filters: rules }, FIELDS))).toEqual(["d"]);
    expect(ids(applyQuery(R, { ...emptyQuery(), join: "any", filters: rules }, FIELDS))).toEqual(["a", "b", "d"]);
  });
});

describe("normalizeQuery", () => {
  it("drops unknown fields, duplicate sort keys and bad directions", () => {
    const q = normalizeQuery(
      {
        join: "whatever",
        sorts: [{ key: "views", dir: "desc" }, { key: "views", dir: "asc" }, { key: "nope", dir: "asc" }, { key: "likes", dir: "up" }],
        filters: [{ field: "nope", op: "gt", value: 1 }, { field: "views", op: "bogus", value: 1 }, { field: "likes", op: "gt", value: 1 }],
      },
      FIELDS,
    );
    expect(q.join).toBe("all");
    expect(q.sorts).toEqual([{ key: "views", dir: "desc" }]);
    expect(q.filters).toEqual([{ field: "likes", op: "gt", value: 1, valueTo: null }]);
  });

  it("survives garbage from storage", () => {
    expect(normalizeQuery(null, FIELDS)).toEqual(emptyQuery());
    expect(normalizeQuery("x", FIELDS)).toEqual(emptyQuery());
  });
});

describe("primary sort helpers", () => {
  it("reads the first sort as the classic key/dir pair, default when none", () => {
    expect(primarySort(emptyQuery())).toEqual({ key: "default", dir: "desc" });
    expect(primarySort({ ...emptyQuery(), sorts: [{ key: "likes", dir: "asc" }] })).toEqual({ key: "likes", dir: "asc" });
  });

  it("replaces only the first sort and keeps the tie-breakers", () => {
    const q = { ...emptyQuery(), sorts: [{ key: "views", dir: "desc" }, { key: "likes", dir: "desc" }] };
    expect(withPrimarySort(q, "date", "asc").sorts).toEqual([{ key: "date", dir: "asc" }, { key: "likes", dir: "desc" }]);
  });

  it("drops a tie-breaker that would duplicate the new primary key", () => {
    const q = { ...emptyQuery(), sorts: [{ key: "views", dir: "desc" }, { key: "likes", dir: "desc" }] };
    expect(withPrimarySort(q, "likes", "asc").sorts).toEqual([{ key: "likes", dir: "asc" }]);
  });

  it("'default' clears every sort — the site's own order", () => {
    const q = { ...emptyQuery(), sorts: [{ key: "views", dir: "desc" }, { key: "likes", dir: "desc" }] };
    expect(withPrimarySort(q, "default", "desc").sorts).toEqual([]);
  });
});

describe("querySignature", () => {
  it("is equal for equal queries and differs when anything changes", () => {
    const a = { ...emptyQuery(), sorts: [{ key: "views", dir: "desc" }] };
    expect(querySignature(a)).toBe(querySignature({ ...a }));
    expect(querySignature(a)).not.toBe(querySignature({ ...a, join: "any" }));
  });
});
