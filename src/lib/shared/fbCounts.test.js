// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readPostCounts, readCountsByControl } from "./fbCounts.js";

// Fixtures mirror the live reel rail (pt-BR UI, verified 2026-08-01 on
// facebook.com/reel/…): three action controls, each with its count as a sibling,
// in the order [reactions, comments, shares].
function unit(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  document.body.replaceChildren(d);
  return d;
}
const rail = (likeLabel, likeCount, commentCount, shareCount) => `
  <div>Astra Vale · Seguir Astra Vale · Áudio original #tag</div>
  <div>
    <div><div role="button" aria-label="${likeLabel}"></div><span>${likeCount}</span></div>
    <div><div role="button" aria-label="Comentar"></div><span>${commentCount}</span></div>
    <div><div role="button" aria-label="Compartilhar"></div><span>${shareCount}</span></div>
  </div>`;

describe("readPostCounts", () => {
  it("reads the reel rail's bare numbers as [reactions, comments, shares]", () => {
    expect(readPostCounts(unit(rail("Curtir", "4,5 mil", "4 mil", "319")))).toEqual({
      like: "4,5 mil",
      comment: "4 mil",
      share: "319",
      views: null,
    });
  });

  it("still reads the counts when the reel is already reacted to", () => {
    // The like control is the ONE label that changes with state: once the warmer
    // reacts, "Curtir" becomes "Amei" / "Remover Curtir" and the old like-anchored
    // scrape found nothing at all.
    expect(readPostCounts(unit(rail("Amei", "8,1 mil", "3,2 mil", "730")))).toEqual({
      like: "8,1 mil",
      comment: "3,2 mil",
      share: "730",
      views: null,
    });
  });

  it("reads a count that shares its span with an icon", () => {
    // FB ships variants where the number sits next to an <svg> inside the same
    // span. A leaf-elements-only scan skips that element and loses the count.
    const html = `
      <div>
        <div><div role="button" aria-label="Curtir"></div><span><svg></svg>2,2 mil</span></div>
        <div><div role="button" aria-label="Comentar"></div><span><svg></svg>247</span></div>
        <div><div role="button" aria-label="Compartilhar"></div><span><svg></svg>111</span></div>
      </div>`;
    expect(readPostCounts(unit(html))).toEqual({
      like: "2,2 mil",
      comment: "247",
      share: "111",
      views: null,
    });
  });

  it("reads the theater's word summary, including views", () => {
    // The watch theater labels its action bar with visible text and puts the
    // summary line after it, instead of a number under each control.
    const html = `
      <div>
        <div><div role="button" aria-label="Curtir">Curtir</div></div>
        <div><div role="button" aria-label="Comentar">Comentar</div></div>
        <div><div role="button" aria-label="Compartilhar">Compartilhar</div></div>
      </div>
      <div>2 · 1 comentário · 103 visualizações</div>`;
    const c = readPostCounts(unit(html));
    expect(c.comment).toBe("1");
    expect(c.views).toBe("103");
  });

  it("returns null when the post shows no counts at all", () => {
    const html = `
      <div>
        <div><div role="button" aria-label="Curtir"></div></div>
        <div><div role="button" aria-label="Comentar"></div></div>
        <div><div role="button" aria-label="Compartilhar"></div></div>
      </div>`;
    expect(readPostCounts(unit(html))).toBe(null);
  });

  it("returns null for a missing container", () => {
    expect(readPostCounts(null)).toBe(null);
  });

  it("ignores numbers that are not counts, like the video timecode", () => {
    const html = `
      <div><span>0:08</span></div>
      ${rail("Curtir", "1,2 mil", "34", "7")}`;
    expect(readPostCounts(unit(html))).toEqual({
      like: "1,2 mil",
      comment: "34",
      share: "7",
      views: null,
    });
  });
});

// ---------------------------------------------------------------------------
// readCountsByControl — the search/hashtag feed reader.
//
// The layout under test is the one live on /search/top?q=%23auralytrend
// (2026-08-15): the like control carries its own number, and a count of ZERO
// prints no number at all — which is exactly what breaks a positional read.
// ---------------------------------------------------------------------------
describe("readCountsByControl", () => {
  // happy-dom lays nothing out, so geometry is faked: `data-x` on an element
  // becomes its rect. Elements without one report the 0×0 box happy-dom gives,
  // which is also what a real unmounted post reports.
  function withGeometry(root) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      const x = el.getAttribute && el.getAttribute("data-x");
      if (x == null) continue;
      const left = Number(x);
      el.getBoundingClientRect = () => ({
        left, right: left + 20, width: 20, top: 100, bottom: 120, height: 20,
      });
    }
    return root;
  }

  // One search-feed action row. A null count renders NO number, like Facebook.
  const feedRow = ({ like, comment, share, likeLabel = "Like" }) => `
    <div>
      <div role="button" aria-label="${likeLabel}" data-x="1013">${like == null ? "" : `<span data-x="1027">${like}</span>`}</div>
      <div role="button" aria-label="React" data-x="1040"></div>
      <div role="button" aria-label="Leave a comment" data-x="1065">${comment == null ? "" : `<span data-x="1079">${comment}</span>`}</div>
      <div role="button" aria-label="Send this to friends or post it on your profile." data-x="1117">${share == null ? "" : `<span data-x="1131">${share}</span>`}</div>
      <div role="button" aria-label="Like: 295 people" data-x="1300"></div>
    </div>`;

  const row = (o) => withGeometry(unit(feedRow(o)));

  it("files each number under its own control", () => {
    expect(readCountsByControl(row({ like: "1.8K", comment: "2K", share: "161" }))).toEqual({
      like: "1.8K",
      comment: "2K",
      share: "161",
    });
  });

  it("does NOT slide the shares into the comments when a count is zero", () => {
    // The regression this function exists for: Facebook renders "4 … 2" for a post
    // with 4 reactions, no comments and 2 shares. Read positionally that is
    // "4 likes, 2 comments" — and it passes a "≥ 2 comments" filter it should fail.
    expect(readCountsByControl(row({ like: "4", comment: null, share: "2" }))).toEqual({
      like: "4",
      comment: null,
      share: "2",
    });
  });

  it("still reads the row once the account has reacted", () => {
    // "Like" becomes "Remove Like" / "Amei" — the label moves, the position doesn't.
    expect(
      readCountsByControl(row({ like: "5.6K", comment: "5.5K", share: "533", likeLabel: "Remover Curtir" })),
    ).toEqual({ like: "5.6K", comment: "5.5K", share: "533" });
  });

  it("ignores the reaction-count tooltip beside the row", () => {
    const html = `
      <div>
        <div role="button" aria-label="Curtir" data-x="1013"><span data-x="1027">19</span></div>
        <div role="button" aria-label="Deixe um comentário" data-x="1065"><span data-x="1079">12</span></div>
        <div role="button" aria-label="Envie para seus amigos ou publique no seu perfil." data-x="1117"><span data-x="1131">3</span></div>
        <div role="button" aria-label="Curtir: 3,5 mil pessoas" data-x="1300"><span data-x="1301">3,5 mil</span></div>
      </div>`;
    expect(readCountsByControl(withGeometry(unit(html)))).toEqual({
      like: "19",
      comment: "12",
      share: "3",
    });
  });

  it("falls back to the positional reading when nothing was ever laid out", () => {
    // An unmounted post reports 0×0 boxes; a full three-number row is still
    // unambiguous, so read it rather than returning nothing.
    const html = `
      <div>
        <div role="button" aria-label="Curtir"></div><span>343</span>
        <div role="button" aria-label="Comentar"></div><span>230</span>
        <div role="button" aria-label="Compartilhar"></div><span>18</span>
      </div>`;
    expect(readCountsByControl(unit(html))).toEqual({
      like: "343",
      comment: "230",
      share: "18",
    });
  });

  it("returns null when the post has no action row — not mounted, not empty", () => {
    expect(readCountsByControl(unit(`<div><span>1.8K</span></div>`))).toBe(null);
    expect(readCountsByControl(null)).toBe(null);
  });
});
