// Paging a Facebook profile's reels for the Spy reel count. Pure; the MAIN-world
// capture script runs it inside the extension's own reels-tab tab, where the
// page's own modules supply the doc_id, tokens and provided variables.
import { parseFbReels } from "./fbReelsData.js";

/** A reel as the hub stores it. */
export function toSpyReel(r) {
  return { id: r.id, createdAt: r.taken_at ?? r.created_at ?? null, duration: r.duration ?? null, views: r.views ?? null };
}

function findShorts(root) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [o, depth] = stack.pop();
    if (!o || typeof o !== "object" || depth > 60) continue;
    if (o.aggregated_fb_shorts && o.aggregated_fb_shorts.page_info) return o;
    for (const v of Object.values(o)) if (v && typeof v === "object") stack.push([v, depth + 1]);
  }
  return null;
}

/**
 * First page, from the server-rendered JSON blocks of the reels tab: the reels,
 * the collection id the pagination query needs, and where to continue.
 */
export function reelsStart(blocks) {
  const out = { collectionId: null, cursor: null, hasNext: false, rows: [] };
  const seen = new Map();
  for (const data of blocks || []) {
    const owner = findShorts(data);
    if (!owner) continue;
    if (!out.collectionId && typeof owner.id === "string") {
      out.collectionId = owner.id;
      out.cursor = owner.aggregated_fb_shorts.page_info.end_cursor || null;
      out.hasNext = !!owner.aggregated_fb_shorts.page_info.has_next_page;
    }
    for (const r of parseFbReels(data)) seen.set(r.id, toSpyReel(r));
  }
  out.rows = [...seen.values()];
  return out;
}

/** Form body of the reels pagination query, exactly as Facebook sends it. */
export function reelsPageBody({ userId, dtsg, lsd, docId, name, provided, cursor, collectionId }) {
  return new URLSearchParams({
    av: userId, __user: userId, __a: "1", fb_dtsg: dtsg, lsd,
    fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: name,
    variables: JSON.stringify({ count: 10, cursor, renderLocation: null, scale: 2, useDefaultActor: false, id: collectionId, ...provided }),
    server_timestamps: "true", doc_id: docId,
  }).toString();
}

/** One streamed page: reels, paging state, or why it failed. */
export function reelsPageResult(text) {
  const out = { rows: [], hasNext: false, cursor: null, error: null };
  if (typeof text !== "string" || !text) return { ...out, error: "empty" };
  if (/"error":\s*1357001/.test(text)) return { ...out, error: "login_required" };
  let pageInfo = null;
  for (const line of text.split("\n")) {
    let part;
    try { part = JSON.parse(line.replace(/^for\s*\(;;\);\s*/, "")); } catch { continue; }
    if (part && part.errors && part.errors.length && !part.data) out.error = "graphql";
    const owner = findShorts(part);
    if (owner && !pageInfo) pageInfo = owner.aggregated_fb_shorts.page_info;
  }
  const seen = new Map();
  for (const r of parseFbReels(text)) seen.set(r.id, toSpyReel(r));
  out.rows = [...seen.values()];
  if (pageInfo) {
    out.hasNext = !!pageInfo.has_next_page;
    out.cursor = pageInfo.end_cursor || null;
  } else if (!out.error) {
    out.error = "no_page";
  }
  return out;
}
