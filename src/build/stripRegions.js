// Build variants from one source tree. A region between marker lines belongs to one
// variant only:
//
//   // @private            (or /* @private */, {/* @private */} in JSX)
//   ...hub, Instagram Scraper, warm engine...
//   // @end-private
//
//   // @public
//   ...the public build's replacement...
//   // @end-public
//
// The public build (PUBLIC=1) drops @private regions; the private build drops
// @public ones. scripts/export-public.mjs runs the same function over the files it
// exports, so the public repo and the public dist cannot disagree.
// Dropped lines become empty lines, so line numbers (and stack traces) still match.

const MARKER = /^\s*(?:\/\/|\/\*|\{\/\*)\s*@(end-)?(private|public)\s*(?:\*\/\}?)?\s*$/;

/** `drop` is the variant whose regions go: "private" for the public build. */
export function stripRegions(code, drop, file = "") {
  if (!/@(end-)?(private|public)/.test(code)) return code;
  const lines = code.split("\n");
  let open = null; // { kind, line }
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i]);
    if (m) {
      const [, end, kind] = m;
      if (!end) {
        if (open) throw new Error(`${file}:${i + 1}: @${kind} inside @${open.kind} (line ${open.line})`);
        open = { kind, line: i + 1 };
      } else {
        if (!open || open.kind !== kind) throw new Error(`${file}:${i + 1}: @end-${kind} without @${kind}`);
        open = null;
      }
      lines[i] = "";
      continue;
    }
    if (open && open.kind === drop) lines[i] = "";
  }
  if (open) throw new Error(`${file}:${open.line}: @${open.kind} never closed`);
  return lines.join("\n");
}

const SOURCE = /\.(m?js|jsx|ts|tsx)$/;

export function stripRegionsPlugin(publicBuild) {
  const drop = publicBuild ? "private" : "public";
  return {
    name: "strip-regions",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!SOURCE.test(file) || file.includes("/node_modules/")) return null;
      const out = stripRegions(code, drop, file);
      return out === code ? null : { code: out, map: null };
    },
  };
}
