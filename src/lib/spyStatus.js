// What the Spy panel says about each profile and about the upload queue. Pure:
// everything comes from the stored list, state and queue, so the panel reads the
// same thing the background acts on.
import { IG_SPY_LIMIT, SPY_RETRY_MS, dayKey } from "./spyStore.js";

export function ago(at, now) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}

const clock = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** kind: measuring | local | paused | waiting | failed | measured | pending */
export function profileStatus(profile, { state = {}, queue = {}, now = Date.now() } = {}) {
  if (state.measuring?.id === profile.id) return { kind: "measuring", text: "medindo agora…" };
  const savePending = (queue.ops || []).some((op) => op.op === "save" && (op.id || `${op.platform}:${op.key}`) === profile.id);
  if (savePending) return { kind: "local", text: "salvo localmente · aguardando envio ao hub" };

  const today = dayKey(now);
  if (profile.lastMeasuredAt != null && dayKey(profile.lastMeasuredAt) === today) {
    const uploading = Object.keys(queue.snapshots || {}).some((key) => key.startsWith(`${profile.id}|`));
    return { kind: "measured", text: `medido ${ago(profile.lastMeasuredAt, now)}${uploading ? " · aguardando envio" : ""}` };
  }
  const blockedUntil = state.blocked?.[profile.platform] || 0;
  if (blockedUntil > now) return { kind: "paused", text: `em pausa até ${clock(blockedUntil)}` };

  const attempt = state.day === today ? state.attempts?.[profile.id] : null;
  const count = typeof attempt === "number" ? attempt : attempt?.n || 0;
  if (count >= 2) return { kind: "failed", text: "falhou hoje · tenta amanhã" };
  if (profile.platform === "instagram" && state.igDaily?.day === today && (state.igDaily.count || 0) >= IG_SPY_LIMIT) {
    return { kind: "waiting", text: "limite diário do Instagram · amanhã" };
  }
  if (count === 1 && attempt?.at && attempt.at + SPY_RETRY_MS > now) {
    return { kind: "waiting", text: `nova tentativa às ${clock(attempt.at + SPY_RETRY_MS)}` };
  }
  if (profile.lastMeasuredAt != null) return { kind: "measured", text: `medido ${ago(profile.lastMeasuredAt, now)}` };
  return { kind: "pending", text: "aguardando medição" };
}

export function syncStatus(queue = {}, state = {}) {
  if (state.lastError === "limit_reached") return { pending: 0, text: "o hub recusou: limite de 100 perfis" };
  const pending = (queue.ops?.length || 0) + Object.keys(queue.profiles || {}).length
    + Object.keys(queue.snapshots || {}).length + Object.keys(queue.errors || {}).length;
  if (!pending) return { pending, text: "sincronizado com o hub" };
  return { pending, text: `${pending} ${pending === 1 ? "alteração" : "alterações"} aguardando envio ao hub` };
}

/** Facebook only: where the reel count stands (first full reading, catch-up). */
export function reelsLine(profile, state = {}) {
  const reels = profile.platform === "facebook" ? profile.reels : null;
  if (!reels) return null;
  const job = state.reelsJob?.profileId === profile.id ? state.reelsJob : null;
  if (reels.status === "done") return `${reels.count} reels${job ? " · buscando novos" : ""}`;
  if (job) return `lendo reels · ${reels.count} até agora`;
  if (reels.status === "running") return `${reels.count}+ reels · a leitura continua`;
  return "reels: na fila para a primeira leitura";
}
