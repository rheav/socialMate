// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { gridCellOf, reorderCells, origIndexOf, stampOrigIndex, setCellHidden } from "./gridSort.js";

const keyOf = (a) => (a.getAttribute("href").match(/\/p\/(\w+)/) || [])[1] || null;

function flatGrid(ids) {
  document.body.innerHTML = `<main><div id="g">${ids.map((i) => `<div class="cell"><a href="/p/${i}/"><img></a></div>`).join("")}</div></main>`;
  return [...document.querySelectorAll(".cell")];
}
// Instagram's profile grid: rows of three, so the cells are NOT siblings.
function rowGrid(ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += 3)
    rows.push(`<div class="row">${ids.slice(i, i + 3).map((x) => `<div class="cell"><a href="/p/${x}/"><img></a></div>`).join("")}</div>`);
  document.body.innerHTML = `<main><div id="g">${rows.join("")}</div></main>`;
  return [...document.querySelectorAll(".cell")];
}
const order = () => [...document.querySelectorAll(".cell a")].map(keyOf);

describe("gridCellOf", () => {
  beforeEach(() => rowGrid(["a", "b", "c"]));

  it("climbs from the link to the grid cell, stopping below the row", () => {
    const a = document.querySelector('a[href="/p/b/"]');
    expect(gridCellOf(a, "a[href]", keyOf).className).toBe("cell");
  });

  it("treats two links to the SAME post as one tile", () => {
    document.body.innerHTML = `<div class="row"><div class="cell"><a href="/p/a/">x</a><a href="/p/a/">caption</a></div><div class="cell"><a href="/p/b/">y</a></div></div>`;
    expect(gridCellOf(document.querySelector("a"), "a[href]", keyOf).className).toBe("cell");
  });
});

describe("reorderCells", () => {
  it("reorders siblings in one pass", () => {
    const cells = flatGrid(["a", "b", "c", "d"]);
    const moved = reorderCells(cells, [cells[3], cells[1], cells[0], cells[2]]);
    expect(order()).toEqual(["d", "b", "a", "c"]);
    expect(moved).toBeGreaterThan(0);
  });

  it("reorders across row parents without changing the row structure", () => {
    const cells = rowGrid(["a", "b", "c", "d", "e", "f"]);
    reorderCells(cells, [...cells].reverse());
    expect(order()).toEqual(["f", "e", "d", "c", "b", "a"]);
    const rows = [...document.querySelectorAll(".row")];
    expect(rows.map((r) => r.children.length)).toEqual([3, 3]);
    expect(document.body.innerHTML).not.toContain("<!--");
  });

  it("does nothing when the order already matches", () => {
    const cells = flatGrid(["a", "b"]);
    expect(reorderCells(cells, [...cells])).toBe(0);
  });

  it("leaves a non-tile sibling where it was", () => {
    document.body.innerHTML = `<div id="g"><div class="cell"><a href="/p/a/"></a></div><span id="ad"></span><div class="cell"><a href="/p/b/"></a></div></div>`;
    const cells = [...document.querySelectorAll(".cell")];
    reorderCells(cells, [cells[1], cells[0]]);
    expect([...document.getElementById("g").children].map((e) => e.id || keyOf(e.querySelector("a")))).toEqual(["b", "ad", "a"]);
  });
});

describe("original order", () => {
  it("stamps each cell once, in document order, and can restore it", () => {
    const cells = flatGrid(["a", "b", "c"]);
    stampOrigIndex(cells);
    const idx = cells.map(origIndexOf);
    expect(idx[0]).toBeLessThan(idx[1]);
    stampOrigIndex(cells); // idempotent
    expect(cells.map(origIndexOf)).toEqual(idx);
    reorderCells(cells, [cells[2], cells[0], cells[1]]);
    const now = [...document.querySelectorAll(".cell")];
    reorderCells(now, [...now].sort((x, y) => origIndexOf(x) - origIndexOf(y)));
    expect(order()).toEqual(["a", "b", "c"]);
  });
});

describe("setCellHidden", () => {
  it("hides and restores the cell's own inline display", () => {
    const [cell] = flatGrid(["a"]);
    cell.style.display = "flex";
    setCellHidden(cell, true);
    expect(cell.style.display).toBe("none");
    setCellHidden(cell, true); // twice must not lose the original
    setCellHidden(cell, false);
    expect(cell.style.display).toBe("flex");
  });
});
