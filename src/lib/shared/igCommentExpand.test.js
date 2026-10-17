import { describe, it, expect } from "vitest";
import { expandComments, isExpandLabel } from "./igCommentExpand.js";

/** A fake page: each click reveals `perClick` comments until `total`. */
function page({ total, perClick, buttons = Infinity, startShown = 15 }) {
  let shown = Math.min(startShown, total);
  let left = buttons;
  let clock = 0;
  return {
    count: () => shown,
    findButton: () => (left > 0 && shown < total ? { id: left } : null),
    click: async () => {
      left -= 1;
      shown = Math.min(total, shown + perClick);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    get clock() {
      return clock;
    },
  };
}

const limits = { maxComments: 200, maxExpansions: 20, maxMs: 90_000, gapMs: [1000, 1000] };

describe("expandComments", () => {
  it("stops at 200 comments", async () => {
    const p = page({ total: 1000, perClick: 30 });
    const r = await expandComments({ ...p, limits, random: () => 0 });
    expect(r).toMatchObject({ stopReason: "limit_comments", captured: 200 });
  });

  it("stops at 20 expansions", async () => {
    const p = page({ total: 1000, perClick: 2 });
    const r = await expandComments({ ...p, limits, random: () => 0 });
    expect(r).toMatchObject({ stopReason: "limit_expansions", expansions: 20 });
  });

  it("stops at 90 seconds", async () => {
    const p = page({ total: 1000, perClick: 1 });
    const r = await expandComments({ ...p, limits: { ...limits, gapMs: [10_000, 10_000], maxExpansions: 99 }, random: () => 0 });
    expect(r.stopReason).toBe("limit_time");
    expect(p.clock).toBeLessThanOrEqual(100_000);
  });

  it("stops when nothing is left to open, or clicks stop revealing anything", async () => {
    expect((await expandComments({ ...page({ total: 40, perClick: 10 }), limits, random: () => 0 })).stopReason).toBe("exhausted");
    expect((await expandComments({ ...page({ total: 1000, perClick: 0 }), limits, random: () => 0 })).stopReason).toBe("no_progress");
  });

  it("can be cancelled between clicks", async () => {
    let cancelled = false;
    const p = page({ total: 1000, perClick: 5 });
    const r = await expandComments({ ...p, click: async () => { await p.click(); cancelled = true; }, limits, cancelled: () => cancelled, random: () => 0 });
    expect(r).toMatchObject({ stopReason: "cancelled", expansions: 1 });
  });
});

describe("isExpandLabel", () => {
  it.each(["Ver respostas (3)", "View replies (12)", "Ver todas as 4 respostas", "View all 4 replies", "Carregar mais comentários", "Load more comments"])(
    "opens %s",
    (label) => expect(isExpandLabel(label)).toBe(true),
  );
  it.each(["Ocultar respostas", "Hide replies", "Responder", "Reply", "Curtir", "Seguir", "Ver tradução"])("ignores %s", (label) => expect(isExpandLabel(label)).toBe(false));
});
