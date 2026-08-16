// Engagement counts (reactions / comments / shares / views) read off a Facebook
// post or reel unit. Canonical source — inlined verbatim into the import-free
// capture scripts by scripts/gen-inline.mjs, see ./README.md.
//
// Two layouts exist:
//   • feed / reel rail: a bare number next to each action control, in the order
//     [reactions, comments, shares];
//   • watch theater: a word summary ("2 · 1 comentário · 103 visualizações")
//     rendered after the Share control, with no per-control numbers.
//
// Two things this deliberately does NOT do the obvious way:
//   1. It anchors on the COMMENT control, not the Like one. "Curtir" is the only
//      label that changes with state — once the account has reacted it reads
//      "Amei" / "Remover Curtir", and a like-anchored scan then found no row and
//      returned null, so the reel was filed with no counts at all.
//   2. It collects TEXT NODES, not leaf elements. FB ships variants where the
//      number shares its span with an icon; a leaf-elements-only scan skips that
//      element and silently drops the count.
export const COUNT_RE = /^\d[\d.,]*\s?(mil|k|m|mi|rb|jt|tis)?$/i;
export const COUNT_LBL = {
  like: /^(like|curtir|gostei|me gusta|j'aime|mi piace|gefällt mir)$/i,
  comment: /leave a comment|comentar|coment[áa]rio|escrever|kommentar|commenter|commenta/i,
  share: /^(share|compartilhar|compartir|partager|teilen|condividi)$/i,
};

function actionControls(root) {
  return [...root.querySelectorAll('[aria-label][role="button"]')];
}
function hasLabel(root, re) {
  return actionControls(root).some((b) => re.test(b.getAttribute("aria-label") || ""));
}
// Every text node under `el`, trimmed. Text nodes have no children by
// definition, so this reaches numbers an element-leaf scan cannot see.
function textNodes(el, out = []) {
  for (const n of el.childNodes) {
    if (n.nodeType === 3) {
      const t = (n.nodeValue || "").trim();
      if (t) out.push(t);
    } else if (n.nodeType === 1) textNodes(n, out);
  }
  return out;
}

// The Share control's label is only the bare word "Compartilhar" on a reel rail.
// In the search / hashtag feed the same control reads "Send this to friends or
// post it on your profile." (pt-BR: "Envie para seus amigos…"), which the exact
// COUNT_LBL.share above deliberately does not match. This wider form is used only
// by readCountsByControl, so the reel scrapers keep their tighter matching.
export const SHARE_LBL_WIDE =
  /^(share|compartilhar|compartir|partager|teilen|condividi)\b|send this to|envie para|env[íi]a esto|envoyer|invia questo|sende dies/i;

// A reaction-count tooltip ("Like: 295 people", "Amei: 3,3 mil pessoas") is also a
// [role="button"][aria-label] inside the action row. Every one of them carries a
// colon; no action control does.
const isTooltipCtrl = (b) => (b.getAttribute("aria-label") || "").indexOf(":") >= 0;

function centerOf(node) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el || !el.getBoundingClientRect) return null;
  const b = el.getBoundingClientRect();
  if (!b.width && !b.height) return null; // never laid out (unmounted, or jsdom)
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}

/**
 * The action row's counts, each filed under the control it belongs to.
 *
 * WHY THIS EXISTS BESIDE readPostCounts: that one reads the row's bare numbers
 * POSITIONALLY, as [reactions, comments, shares]. Facebook prints NO number beside
 * a control whose count is zero, so a post with no comments renders "4 … 2" and the
 * positional read files its 2 shares as 2 comments — which silently passes a
 * "≥ 2 comments" filter. Verified live on /search/top?q=%23auralytrend
 * (2026-08-15): numbers at x≈1027 and x≈1131 against controls at like x≈1013,
 * comment x≈1065, share x≈1117.
 *
 * So each number is filed by WHERE IT IS, not by how many came before it:
 *   1. inside one of the three controls → that control (survives any layout);
 *   2. otherwise the nearest control by centre distance;
 *   3. and if nothing was ever laid out (an unmounted post, or a test DOM), a
 *      3-number row falls back to the positional reading.
 *
 * Returns the raw localized strings — parse with parseCount from ./counts.js —
 * or null when the post has no action row yet, which on a virtualized feed means
 * "not mounted", not "no engagement".
 */
export function readCountsByControl(container) {
  if (!container) return null;
  const anchor = actionControls(container).find((b) =>
    COUNT_LBL.comment.test(b.getAttribute("aria-label") || ""),
  );
  if (!anchor) return null;

  // Climb to the smallest ancestor holding the whole action row, and never past
  // the post itself — on a reacted post the "Like" label is gone, and an unbounded
  // climb would walk into the neighbouring post's row.
  let row = anchor;
  for (let i = 0; i < 7 && row.parentElement && row !== container; i++) {
    row = row.parentElement;
    if (actionControls(row).filter((b) => !isTooltipCtrl(b)).length >= 2) break;
  }

  const controls = actionControls(row).filter((b) => !isTooltipCtrl(b));
  const at = controls.indexOf(anchor);
  const share = controls.find((b) => SHARE_LBL_WIDE.test(b.getAttribute("aria-label") || ""));
  // The like control is whatever action sits before Comment in the bar. Matching
  // it by label would need every reaction word in every locale ("Amei", "Remover
  // Curtir", "Change Like reaction"); its POSITION never changes.
  const like = at > 0 ? controls[0] : null;
  const slots = [
    ["like", like],
    ["comment", anchor],
    ["share", share || null],
  ].filter(([, el]) => el);

  const out = { like: null, comment: null, share: null };
  const numbers = [];
  (function walk(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const t = (n.nodeValue || "").trim();
        if (t && t.length <= 8 && COUNT_RE.test(t)) numbers.push(n);
      } else if (n.nodeType === 1) walk(n);
    }
  })(row);

  let placed = 0;
  for (const node of numbers) {
    let kind = null;
    for (const [k, el] of slots) if (el.contains(node)) kind = k;
    if (!kind) {
      const c = centerOf(node);
      let best = Infinity;
      if (c)
        for (const [k, el] of slots) {
          const cc = centerOf(el);
          if (!cc) continue;
          // Vertical distance is weighted: a wrapped row stacks the controls, and
          // a number one line down belongs to the control above it, not to the one
          // that happens to share its column.
          const d = Math.hypot(c.x - cc.x, (c.y - cc.y) * 3);
          if (d < best) {
            best = d;
            kind = k;
          }
        }
    }
    if (kind && out[kind] == null) {
      out[kind] = (node.nodeValue || "").trim();
      placed++;
    }
  }

  // Nothing could be placed by containment OR geometry (never laid out): fall back
  // to the positional reading, which is right whenever all three numbers are shown.
  if (!placed && numbers.length === 3) {
    const t = (n) => (n.nodeValue || "").trim();
    return { like: t(numbers[0]), comment: t(numbers[1]), share: t(numbers[2]) };
  }
  return out;
}

export function readPostCounts(container) {
  if (!container) return null;
  // (a) bare numbers from the action row
  const bare = [];
  const controls = actionControls(container);
  const anchor =
    controls.find((b) => COUNT_LBL.comment.test(b.getAttribute("aria-label") || "")) ||
    controls.find((b) => COUNT_LBL.like.test(b.getAttribute("aria-label") || ""));
  if (anchor) {
    // Climb to the smallest ancestor holding the whole action row. "Holds the
    // row" = it carries the comment control plus at least one of the other two,
    // so it works whether we anchored on Comment or on Like.
    let row = anchor;
    for (let i = 0; i < 7 && row.parentElement; i++) {
      row = row.parentElement;
      if (
        hasLabel(row, COUNT_LBL.comment) &&
        (hasLabel(row, COUNT_LBL.like) || hasLabel(row, COUNT_LBL.share))
      )
        break;
    }
    for (const t of textNodes(row)) if (t.length <= 8 && COUNT_RE.test(t)) bare.push(t);
  }
  // (b) word summary after the Share control
  const text = (container.innerText || container.textContent || "").replace(/\s+/g, " ");
  const SHARE_W =
    /\b(?:share|compartilhar|compartilhamentos?|compartir|partager|condividi|teilen)\b/i;
  const af = SHARE_W.test(text) ? text.split(SHARE_W).pop() : "";
  const num = "([\\d.,]+\\s?(?:mil|k|m|mi|rb|jt)?)";
  const w = (re) => {
    const m = af.match(new RegExp(re, "i"));
    return m ? m[1].trim() : null;
  };
  const reactW = (af.trim().match(/^(\d[\d.,]*\s?(?:mil|k|m|mi)?)/i) || [])[1];
  const counts = {
    like: bare[0] || (reactW ? reactW.trim() : null),
    comment:
      w(num + "\\s+(?:comments?|coment[áa]rios?|comentarios?|commentaires?|commenti|kommentare?)\\b") ||
      bare[1] ||
      null,
    share:
      w(num + "\\s+(?:shares?|compartilhamentos?|compartidos?|partages?|condivisioni|freigaben)\\b") ||
      bare[2] ||
      null,
    views: w(num + "\\s*(?:views?|visualiz\\w*)\\b"),
  };
  return counts.like || counts.comment || counts.share || counts.views ? counts : null;
}
