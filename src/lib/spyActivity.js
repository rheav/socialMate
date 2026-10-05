// The spy area's activity log: each step the background takes (a click, a batch
// opening, a profile read or failed, an upload) with its reason, newest last. The
// panel shows it as is, so the texts are pt-BR and self-explanatory.
export const SPY_ACTIVITY_KEY = "fbw_spy_activity";
// Result of the last upload to the hub: { ok, at, sent?, error?, status? }.
export const SPY_HUB_KEY = "fbw_spy_hub";
export const ACTIVITY_CAP = 40;

/** tone: info | ok | warn | error. platform: instagram | facebook | hub | null. */
export function appendActivity(list, entry, cap = ACTIVITY_CAP) {
  return [...(Array.isArray(list) ? list : []), entry].slice(-cap);
}

const ERRORS = {
  not_found: "perfil não encontrado",
  parse_failed: "a página abriu mas não trouxe os números",
  network: "falha de rede",
  login_required: "a rede pediu login — confira se a conta está conectada neste Chrome",
  rate_limited: "a rede limitou as consultas",
  no_bridge: "a aba não respondeu",
  tab_closed: "a aba foi fechada",
  failed: "falhou",
};
export function errorText(code) {
  return ERRORS[code] || (code ? String(code) : ERRORS.failed);
}

export function profileName(profile) {
  if (!profile) return "perfil";
  if (profile.name) return profile.name;
  return /^\d+$/.test(profile.key || "") ? `perfil ${profile.key}` : `@${profile.key}`;
}

const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
export function countText(n) {
  return Number.isFinite(n) ? compact.format(n) : "?";
}

export function clockText(ms, seconds = false) {
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
}
