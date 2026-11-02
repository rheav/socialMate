// FB's reel rail appends a count to its action labels ("Like, 6.8K reactions",
// "Remove Like, 6.8K reactions"); the action is whatever precedes the comma.
// shortcut: a "Follow Foo, Inc." author is cut at the comma too, harmless while
// the name is only a per-author key; read the raw label if it is ever displayed.
export const fbActionName = (label) =>
  (label || "").split(",")[0].trim().toLowerCase();
