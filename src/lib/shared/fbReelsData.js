// Compact Facebook reel records from hydration and streamed GraphQL. No requests.
import { parseCount } from "./counts.js";
import { collectFbVideos } from "./fbVideoMedia.js";

export function fbReelsSurface(href) {
  try {
    const u = new URL(href, "https://www.facebook.com");
    if (!/(^|\.)facebook\.com$/.test(u.hostname)) return null;
    const reel = u.pathname.match(/^\/reel\/(\d+)/);
    if (reel) return `reel:${reel[1]}`;
    if (u.pathname === '/profile.php' && /^(reels_tab|owner_reels)$/.test(u.searchParams.get('sk')) && /^\d+$/.test(u.searchParams.get('id')))
      return `profile:${u.searchParams.get('id')}`;
    const profile = u.pathname.match(/^\/([^/]+)\/(?:reels|reels_tab)\/?$/);
    return profile ? `profile:${profile[1].toLowerCase()}` : null;
  } catch { return null; }
}

export function mergeFbReel(prev, next) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next || {})) {
    if (v != null && v !== '' && (!Array.isArray(v) || v.length)) out[k] = v;
    else if (!(k in out)) out[k] = v;
  }
  return out;
}

function fbReelUrlId(url) {
  try {
    const u = new URL(url, 'https://www.facebook.com');
    return /(^|\.)facebook\.com$/.test(u.hostname) ? u.pathname.match(/^\/reel\/(\d+)/)?.[1] || null : null;
  } catch { return null; }
}

export function parseFbReels(input, activeId = null) {
  const parts = typeof input === 'string' ? input.split('\n').flatMap(line => {
    try { return [JSON.parse(line.replace(/^for\s*\(;;\);\s*/, ''))]; } catch { return []; }
  }) : Array.isArray(input) ? input : [input];
  const records = new Map(), videos = new Map(), edgeIds = new Map();
  const empty = id => ({ id, views: null, likes: null, comments: null, shares: null,
    taken_at: null, created_at: null, duration: null, caption: null, authorName: null,
    authorId: null, authorUrl: null, thumb: null, progressive: null, audio: null, captions: [],
    sourceUrl: `https://www.facebook.com/reel/${id}`, media_type: 'video' });
  function put(id, row) {
    if (!/^\d{6,}$/.test(id || '')) return;
    records.set(id, mergeFbReel(records.get(id) || empty(id), { ...row, id }));
  }
  function stats(o) {
    return { likes: parseCount(o.fb_reel_react_button?.story?.feedback?.likers?.count),
      comments: parseCount(o.feedback?.total_comment_count), shares: parseCount(o.feedback?.share_count_reduced) };
  }
  let budget = 220000;
  function walk(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 60 || --budget < 0) return;
    if (o.aggregated_fb_shorts?.edges) {
      o.aggregated_fb_shorts.edges.forEach((e, i) => {
        const id = e.profile_reel_node?.node?.attachments?.find(a => a.media?.__typename === 'Video')?.media?.id;
        if (id) edgeIds.set(i, id);
      });
    }
    const media = o.attachments?.find?.(a => a.media?.__typename === 'Video')?.media;
    if (media?.id && (o.__typename === 'Story' || o.actors || o.creation_time)) {
      const actor = o.actors?.[0];
      put(media.id, { taken_at: Number.isFinite(o.creation_time) ? o.creation_time : null,
        caption: o.message?.text || null, authorName: actor?.name || null,
        authorId: actor?.id || null, authorUrl: actor?.id ? `https://www.facebook.com/profile.php?id=${actor.id}` : null });
    }
    const id = fbReelUrlId(o.url);
    if (id && (o.feedback || o.fb_reel_react_button)) put(id, stats(o));
    if (o.__typename === 'Video' && /^\d{6,}$/.test(o.id || '')) {
      const delivery = collectFbVideos(o).find(r => r.id === o.id);
      videos.set(o.id, mergeFbReel(videos.get(o.id), {
        id: o.id, views: parseCount(o.play_count_reduced ?? o.play_count),
        created_at: Number.isFinite(o.created_time) ? o.created_time : null,
        duration: delivery?.durationS || null, thumb: delivery?.thumbs?.[0] || null,
        progressive: delivery?.progressive || null, audio: delivery?.audio || null, captions: delivery?.captions || [],
        authorName: o.owner?.name || null, authorId: o.owner?.id || null,
        authorUrl: o.owner?.id ? `https://www.facebook.com/profile.php?id=${o.owner.id}` : null,
      }));
    }
    for (const v of Object.values(o)) if (typeof v === 'object') walk(v, depth + 1);
  }
  // Base connections must be indexed before any out-of-order deferred part.
  for (const p of parts) if (!p?.path) walk(p);
  for (const p of parts) {
    if (!p?.path) continue;
    const at = p.path.indexOf('edges');
    const id = at >= 0 ? edgeIds.get(p.path[at + 1]) : null;
    const urlId = fbReelUrlId(p.data?.url);
    if (id && urlId && id !== urlId) continue;
    if (id) put(id, stats(p.data || {}));
    walk(p.data);
  }
  if (activeId && videos.has(activeId)) put(activeId, {});
  for (const [id, row] of records) {
    const merged = mergeFbReel(videos.get(id), row);
    // Null placeholders in a partial story must not erase the video delivery.
    records.set(id, merged);
  }
  return [...records.values()];
}
