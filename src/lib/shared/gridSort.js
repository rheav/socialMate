// Reordering a site's own grid in place. Canonical source — INLINED into the
// Instagram bridge and the TikTok relay (see ./README.md: no imports here).
//
// The unit that moves is the grid CELL: the outermost box around one tile that
// holds no other tile. On TikTok the cells are siblings; on Instagram's profile
// grid they sit in rows of three, so a sort has to move cells ACROSS parents. It
// does that by dropping a comment marker in front of every cell (one marker per
// slot), putting the i-th sorted cell after the i-th marker, and removing the
// markers — rows keep their three children, and anything that is not a tile (an
// ad, a "load more" row) never moves. When every cell is a contiguous sibling
// run, one DocumentFragment insert does it instead.
//
// Every cell is stamped with the order it was first seen in, so "Padrão" can
// put the grid back exactly as the site drew it.

const ORIG_KEY = "__swOrigIndex";
let swOrigCounter = 0;

/**
 * The grid cell around a tile link: climb while the parent still holds only
 * links to this same post (a tile often carries two — the thumbnail and the
 * caption line).
 */
export function gridCellOf(link, linkSelector, keyOf, maxUp = 8) {
  const key = keyOf(link);
  let cell = link;
  for (let i = 0; i < maxUp; i++) {
    const p = cell.parentElement;
    if (!p || p === document.body || p === document.documentElement) break;
    let other = false;
    for (const a of p.querySelectorAll(linkSelector)) {
      const k = keyOf(a);
      if (k && k !== key) { other = true; break; }
    }
    if (other) break;
    cell = p;
  }
  return cell;
}

/** Give every not-yet-seen cell its first-seen position (document order in). */
export function stampOrigIndex(cells) {
  for (const c of cells) if (c[ORIG_KEY] == null) c[ORIG_KEY] = swOrigCounter++;
}

export function origIndexOf(cell) {
  return cell[ORIG_KEY] == null ? Number.MAX_SAFE_INTEGER : cell[ORIG_KEY];
}

function contiguousSiblings(cells) {
  const parent = cells[0].parentElement;
  if (!parent) return false;
  const set = new Set(cells);
  let n = cells[0];
  let seen = 0;
  while (n && seen < cells.length) {
    if (n.nodeType === 1) {
      if (!set.has(n)) return false;
      seen++;
    }
    n = n.nextSibling;
  }
  return seen === cells.length && cells.every((c) => c.parentElement === parent);
}

/**
 * Put `ordered` into the slots `cells` occupy now (both in any order; `cells`
 * is read in document order). Returns how many slots changed.
 */
export function reorderCells(cells, ordered) {
  const slots = [...cells].sort((a, b) =>
    a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
  let changed = 0;
  for (let i = 0; i < slots.length; i++) if (slots[i] !== ordered[i]) changed++;
  if (!changed) return 0;
  if (contiguousSiblings(slots)) {
    const parent = slots[0].parentElement;
    const after = slots[slots.length - 1].nextSibling;
    const frag = document.createDocumentFragment();
    for (const c of ordered) frag.appendChild(c);
    parent.insertBefore(frag, after);
    return changed;
  }
  const markers = slots.map((c) => {
    const m = document.createComment("sw-slot");
    c.parentNode.insertBefore(m, c);
    return m;
  });
  for (let i = 0; i < ordered.length; i++) markers[i].parentNode.insertBefore(ordered[i], markers[i].nextSibling);
  for (const m of markers) m.remove();
  return changed;
}

/** Hide a cell a filter rejects, remembering its own inline display. */
export function setCellHidden(cell, hide) {
  if (hide) {
    if (cell.dataset.swHidden === "1") return;
    cell.dataset.swHidden = "1";
    cell.dataset.swPrevDisplay = cell.style.display || "";
    cell.style.display = "none";
  } else if (cell.dataset.swHidden === "1") {
    cell.style.display = cell.dataset.swPrevDisplay || "";
    delete cell.dataset.swHidden;
    delete cell.dataset.swPrevDisplay;
  }
}
