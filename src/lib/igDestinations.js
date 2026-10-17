// Where the Instagram research records go: the Instagram Scraper backend
// (~/Code/apps/instagram-scraper), local and/or production. This replaces the
// configuration of the old "IG Market Research Bridge" extension.
//
// Kept apart from `fbw_sync` (the socialMate hub): different server, different
// token, and each destination is delivered and confirmed on its own.

export const IG_DESTINATIONS_KEY = "fbw_ig_destinations";
export const IG_DESTINATION_IDS = ["local", "prod"];

const DEFAULTS = {
  local: { enabled: false, url: "http://localhost:3001", token: "" },
  prod: { enabled: false, url: "", token: "" },
};

/** Stored value → `{ local: {enabled,url,token}, prod: {...} }`, always complete. */
export function igDestinationSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const id of IG_DESTINATION_IDS) {
    const d = src[id] && typeof src[id] === "object" ? src[id] : {};
    out[id] = {
      enabled: !!d.enabled,
      url: typeof d.url === "string" ? d.url.trim().replace(/\/+$/, "") : DEFAULTS[id].url,
      token: typeof d.token === "string" ? d.token.trim() : "",
    };
  }
  return out;
}

/** The destinations that receive new captures and hold a presence socket. */
export function enabledIgDestinations(settings) {
  const s = igDestinationSettings(settings);
  return IG_DESTINATION_IDS.filter((id) => s[id].enabled && /^https?:\/\//.test(s[id].url) && s[id].token).map(
    (id) => ({ id, url: s[id].url, token: s[id].token }),
  );
}

/** A destination by id, enabled or not: a paused destination still drains on request. */
export function igDestination(settings, id) {
  const s = igDestinationSettings(settings);
  const d = s[id];
  if (!d || !/^https?:\/\//.test(d.url) || !d.token) return null;
  return { id, url: d.url, token: d.token, enabled: d.enabled };
}
