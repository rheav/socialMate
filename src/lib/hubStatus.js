// The header's connection dot: is the socialMate hub (the Acervo) reachable?
//
// Two things answer that, and the most recent one wins: the panel's own ping
// (every 60s while the panel is visible) and the background's real syncs, which
// write lastOkAt / error+errorAt into fbw_sync_state. A sync that fails right after
// a good ping is news; a ping from a minute ago is not.

export function timeAgo(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return "agora";
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}

function describeFailure({ error, status } = {}) {
  const code = Number(status) || Number(/HTTP (\d{3})/.exec(String(error || ""))?.[1]) || 0;
  if (code === 401 || code === 403) return `token recusado (${code})`;
  if (code === 503) return "sync desligado no servidor (503)";
  if (code) return `servidor respondeu ${code}`;
  return "sem resposta do servidor";
}

/**
 * @param {{configured: boolean, ping: {at:number, ok:boolean, error?:string, status?:number}|null,
 *          state: {lastOkAt?:number, error?:string|null, errorAt?:number}, now?: number}} input
 * @returns {{tone: "off"|"checking"|"ok"|"warn", title: string}}
 */
export function hubStatus({ configured, ping, state, now = Date.now() }) {
  if (!configured) return { tone: "off", title: "" };
  const st = state || {};
  const signals = [];
  if (ping && ping.at) signals.push(ping);
  if (st.lastOkAt) signals.push({ at: st.lastOkAt, ok: true });
  if (st.error && st.errorAt) signals.push({ at: st.errorAt, ok: false, error: st.error });
  if (!signals.length) return { tone: "checking", title: "Acervo: verificando conexão…" };

  const latest = signals.reduce((a, b) => (b.at > a.at ? b : a));
  if (latest.ok) return { tone: "ok", title: `Acervo conectado · verificado ${timeAgo(latest.at, now)}` };

  const lastOk = Math.max(ping?.ok ? ping.at : 0, st.lastOkAt || 0);
  const since = lastOk ? ` · último contato ok ${timeAgo(lastOk, now)}` : "";
  return { tone: "warn", title: `Acervo com problema: ${describeFailure(latest)}${since}` };
}
