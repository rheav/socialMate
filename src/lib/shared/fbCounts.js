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
