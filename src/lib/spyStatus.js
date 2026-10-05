// What the Spy panel says about each profile and about the upload queue. Pure:
// everything comes from the stored list, state and queue, so the panel reads the
// same thing the background acts on.
import { IG_SPY_LIMIT, SPY_RETRY_MS, dayKey } from "./spyStore.js";
import { clockText, errorText, profileName } from "./spyActivity.js";

export function ago(at, now) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}

const clock = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** kind: measuring | local | paused | waiting | failed | measured | pending */
export function profileStatus(profile, { state = {}, queue = {}, now = Date.now(), igLimit = IG_SPY_LIMIT } = {}) {
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
  if (profile.platform === "instagram" && state.igDaily?.day === today && (state.igDaily.count || 0) >= igLimit) {
    return { kind: "waiting", text: "limite diário do Instagram · amanhã" };
  }
  if (count === 1 && attempt?.at && attempt.at + SPY_RETRY_MS > now) {
    return { kind: "waiting", text: `nova tentativa às ${clock(attempt.at + SPY_RETRY_MS)}` };
  }
  if (profile.lastMeasuredAt != null) return { kind: "measured", text: `medido ${ago(profile.lastMeasuredAt, now)}` };
  return { kind: "pending", text: "aguardando medição" };
}

const QUEUE_KINDS = ["profiles", "snapshots", "errors", "readings", "reels", "reelsStatus", "posts"];
export function hubErrorText(hub) {
  if (hub.status === 401 || hub.status === 403) return "token recusado — confira o token em Opções";
  if (hub.status === 404) return "o hub não tem a área spy — atualize o hub";
  if (hub.status >= 500) return `o hub respondeu erro ${hub.status}`;
  if (hub.status) return `o hub respondeu ${hub.status}`;
  return "hub fora do ar ou sem rede";
}

/** The upload queue and the last upload. tone: ok | info | warn. */
export function syncStatus(queue = {}, state = {}, hub = null, now = Date.now()) {
  const pending = (queue.ops?.length || 0)
    + QUEUE_KINDS.reduce((n, kind) => n + Object.keys(queue[kind] || {}).length, 0);
  if (state.lastError === "limit_reached") return { pending: 0, tone: "warn", text: "o hub recusou: limite de 100 perfis" };
  const records = `${pending} ${pending === 1 ? "registro" : "registros"}`;
  if (hub && hub.ok === false) {
    return { pending, tone: "warn",
      text: `${pending ? `${records} aguardando envio · ` : ""}último envio falhou ${ago(hub.at, now)} (${hubErrorText(hub)}) · tenta de novo sozinho` };
  }
  if (!pending) return { pending, tone: "ok", text: `sincronizado com o hub${hub?.at ? ` · último envio ${ago(hub.at, now)}` : ""}` };
  return { pending, tone: "info", text: `${records} aguardando envio ao hub` };
}

function wait(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s === 0) return "instantes";
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * What the background is doing right now, line by line, for the panel. Pure:
 * derived from the stored state; nextTickAt is the scheduled automatic tick.
 * line: { platform, text, detail?, spinning, tone }
 */
export function activityNow(state = {}, profiles = [], { now = Date.now(), nextTickAt = null, dailyOff = false } = {}) {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const name = (id) => profileName(byId.get(id) || { key: String(id || "").split(":")[1] });
  const lines = [];
  for (const platform of ["instagram", "facebook"]) {
    const until = state.blocked?.[platform] || 0;
    if (until > now) {
      lines.push({ platform, tone: "warn", spinning: false,
        text: `Em pausa até ${clockText(until)} — ${errorText(state.blockedReason?.[platform] || "rate_limited")}` });
    }
  }
  const batch = state.igBatch;
  if (batch) {
    const pending = batch.pending || [];
    const total = Math.max(batch.total || 0, pending.length);
    const head = `Lote ${batch.manualAt ? "manual" : "diário"} · ${total - pending.length} de ${total} perfis`
      + (batch.failed ? ` (${batch.failed} com falha)` : "");
    const reading = state.measuring?.platform === "instagram" ? state.measuring.key : null;
    let text;
    let rest = pending;
    if (reading) { text = `${head} · lendo @${reading}…`; rest = pending.filter((k) => k !== reading); }
    else if (pending.length) { text = `${head} · próximo @${pending[0]} em ${wait((batch.nextAt || now) - now)}`; rest = pending.slice(1); }
    else text = `${head} · encerrando…`;
    lines.push({ platform: "instagram", tone: "info", spinning: !!reading, text,
      ...(rest.length ? { detail: `na fila depois: ${rest.map((k) => `@${k}`).join(", ")}` } : {}) });
  }
  if (state.measuring?.platform === "facebook") {
    lines.push({ platform: "facebook", tone: "info", spinning: true, text: `Lendo ${name(state.measuring.id)}…` });
  }
  const fbQueue = state.fbManual || [];
  if (fbQueue.length) {
    lines.push({ platform: "facebook", tone: "info", spinning: false,
      text: `${fbQueue.length} na fila do Medir agora · próximo ${name(fbQueue[0])} ${nextTickAt ? `em ${wait(nextTickAt - now)}` : "em instantes"}` });
  }
  const job = state.reelsJob;
  if (job) {
    const pages = `${job.pages || 0} ${job.pages === 1 ? "página" : "páginas"}, ${job.added || 0} reels`;
    lines.push({ platform: "facebook", tone: "info", spinning: false,
      text: `Reels de ${name(job.profileId)} (${job.mode === "catchup" ? "continuação" : "leitura inicial"}) · ${pages} · próxima página em ${wait((job.nextAt || now) - now)}` });
  }
  const busy = !!(batch || fbQueue.length || state.measuring || job);
  if (!busy && dailyOff) {
    lines.push({ platform: null, tone: "info", spinning: false,
      text: "Nada em andamento · medição diária desligada em Opções; o Medir agora continua funcionando" });
  } else if (!busy) {
    lines.push({ platform: null, tone: "info", spinning: false,
      text: `Nada em andamento${nextTickAt ? ` · próxima passada automática ${nextTickAt - now < 3600000 ? `em ${wait(nextTickAt - now)}` : `às ${clockText(nextTickAt)}`}` : ""}` });
  }
  return { busy, lines };
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
