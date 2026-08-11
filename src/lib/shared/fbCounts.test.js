// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readPostCounts } from "./fbCounts.js";

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
