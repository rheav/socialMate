// The extension's line to the Hub's analyses (T8): a WebSocket to
// `<acervo>/ws/socialmate-extension`, authenticated by the Acervo sync token in
// the first frame (never the URL). The Hub pushes one collection job at a time
// under a lease; this keeps the lease alive while the collector works, and
// reports the outcome once. A result the Hub has not acknowledged is kept in
// storage and sent again after a reconnect or a worker restart — the Hub
// recognises the same lease and answers a duplicate ack.
//
// Control only: the video and the evidence go over HTTP (analysisCollect.js).

import { reconnectDelay } from "../lib/igPresence.js";

export const ANALYSIS_WS_PATH = "/ws/socialmate-extension";
export const ANALYSIS_RELAY_KEY = "fbw_analysis_relay"; // { instanceId, pending }
const HEARTBEAT_MS = 20_000;
const STALE_MS = 60_000;

export function analysisWsUrl(httpUrl) {
  return String(httpUrl).replace(/\/+$/, "").replace(/^http/, "ws") + ANALYSIS_WS_PATH;
}

/**
 * @param {object} deps
 * @param {typeof WebSocket} deps.WebSocketImpl
 * @param {() => Promise<{url,token}|null>} deps.settings  the Acervo sync settings
 * @param {{get,set}} deps.storage  chrome.storage.local
 * @param {{ preparePost(job, {progress}), cancelPrepare(taskId) }} deps.collect
 * @param {Record<string, (msg, reply: { progress(fields), result(ok, fields) }) => Promise>} [deps.commands]
 *   Hub commands outside the analysis tasks (the Stories' "Coletar stories"): one
 *   handler per name; what it reports goes back as command_progress / command_result.
 */
export function createAnalysisRelay({ WebSocketImpl, settings, storage, collect, version, random = Math.random, commands = {} }) {
  if (!WebSocketImpl) return { ensure: async () => {}, close() {}, status: () => ({ connected: false }) };
  const OPEN = WebSocketImpl.OPEN ?? 1;
  const CONNECTING = WebSocketImpl.CONNECTING ?? 0;
  let ws = null;
  let target = null; // { url, token } of the current socket
  let attempt = 0;
  let retry = null;
  let watch = null;
  let lastHeardAt = 0;
  let authFailedToken = null;
  let welcomed = false;
  let working = null; // { taskId, leaseToken, beat }
  let closed = false;

  async function load() {
    const r = await storage.get(ANALYSIS_RELAY_KEY);
    return { instanceId: null, pending: null, ...(r[ANALYSIS_RELAY_KEY] || {}) };
  }
  async function save(patch) {
    await storage.set({ [ANALYSIS_RELAY_KEY]: { ...(await load()), ...patch } });
  }
  async function instanceId() {
    const s = await load();
    if (s.instanceId) return s.instanceId;
    const id = `ext-${(globalThis.crypto?.randomUUID?.() || String(random()).slice(2)).slice(0, 12)}`;
    await save({ instanceId: id });
    return id;
  }

  function send(msg) {
    if (ws?.readyState === OPEN && welcomed) ws.send(JSON.stringify(msg));
  }

  function stopTimers() {
    clearInterval(watch);
    clearTimeout(retry);
    watch = retry = null;
  }

  function scheduleReconnect() {
    clearTimeout(retry);
    const delay = reconnectDelay(attempt, random);
    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      ensure().catch(() => {});
    }, delay);
  }

  async function finish(task, outcome) {
    clearInterval(task.beat);
    if (working === task) working = null;
    if (outcome?.code === "cancelled") return; // the Hub already ended it
    const msg = outcome?.ok
      ? { type: "result", taskId: task.taskId, leaseToken: task.leaseToken, result: outcome.result }
      : { type: "error", taskId: task.taskId, leaseToken: task.leaseToken, code: outcome?.code || "collect_failed" };
    await save({ pending: msg });
    send(msg);
  }

  function runJob(msg) {
    if (working) {
      send({ type: "error", taskId: msg.taskId, leaseToken: msg.leaseToken, code: "busy" });
      return;
    }
    const task = { taskId: msg.taskId, leaseToken: msg.leaseToken, beat: null, live: null };
    working = task;
    const beat = () => send({ type: "heartbeat", taskId: task.taskId, leaseToken: task.leaseToken, ...(task.live ? { live: task.live } : {}) });
    task.beat = setInterval(beat, HEARTBEAT_MS);
    const progress = (code, detail) => send({ type: "progress", taskId: task.taskId, leaseToken: task.leaseToken, code, ...(detail ? { detail } : {}) });
    // What the collector is doing now: sent at once on a new phase, then with every heartbeat.
    const live = (patch) => {
      const fresh = !task.live || patch.phase !== task.live.phase;
      task.live = fresh
        ? { phase: patch.phase, provider: null, detail: patch.detail ?? null, stepStartedAt: Date.now(), activityAt: null, toolCalls: null, framesOpened: null, framesTotal: null, lastTool: null, lastFile: null }
        : { ...task.live, ...patch };
      if (fresh) beat();
    };
    Promise.resolve()
      .then(() => collect.preparePost({ taskId: msg.taskId, leaseToken: msg.leaseToken, deadlineAt: msg.deadlineAt ?? null, payload: msg.payload || {} }, { progress, live }))
      .then(
        (out) => finish(task, out),
        () => finish(task, { ok: false, code: "collect_failed" }),
      );
  }

  /** A hub command: its handler reports through `reply`; an unknown name is answered at once. */
  function runCommand(msg) {
    const requestId = String(msg.requestId || "");
    const reply = {
      progress: (fields = {}) => send({ type: "command_progress", requestId, ...fields }),
      result: (ok, fields = {}) => send({ type: "command_result", requestId, ok: !!ok, ...fields }),
    };
    const handler = commands[msg.command];
    if (typeof handler !== "function") {
      reply.result(false, { error: "unknown_command" });
      return;
    }
    Promise.resolve()
      .then(() => handler(msg, reply))
      .catch(() => reply.result(false, { error: "command_failed" }));
  }

  async function onMessage(raw) {
    lastHeardAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg?.type) {
      case "command":
        return runCommand(msg);
      case "welcome": {
        welcomed = true;
        attempt = 0;
        const { pending } = await load();
        if (pending) send(pending);
        return;
      }
      case "ping":
        return send({ type: "pong", at: Date.now() });
      case "job":
        return runJob(msg);
      case "cancel":
        await collect.cancelPrepare(String(msg.taskId || ""));
        return;
      case "ack":
      case "nack": {
        const { pending } = await load();
        if (pending && pending.taskId === msg.taskId) await save({ pending: null });
        return;
      }
      default:
        return;
    }
  }

  function connect(next, id) {
    // A wake-up (the minute alarm, new sync settings) does not wait out the backoff: timers stand still while the Mac sleeps.
    stopTimers();
    let sock;
    try {
      sock = new WebSocketImpl(analysisWsUrl(next.url));
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    target = next;
    welcomed = false;
    lastHeardAt = Date.now();
    sock.addEventListener("open", () => {
      lastHeardAt = Date.now();
      const names = Object.keys(commands);
      const capabilities = { collect: true, ...(names.length ? { commands: names } : {}) };
      sock.send(JSON.stringify({ type: "hello", role: "extension", token: next.token, instanceId: id, version, capabilities }));
      // The Hub pings every 20 s: a minute of silence means the line is gone.
      watch = setInterval(() => {
        if (Date.now() - lastHeardAt >= STALE_MS) {
          try {
            sock.close(4000, "stale");
          } catch {
            /* close owns the retry */
          }
        }
      }, HEARTBEAT_MS);
    });
    sock.addEventListener("message", (ev) => {
      onMessage(ev.data).catch(() => {});
    });
    sock.addEventListener("close", (ev) => {
      if (ws !== sock) return;
      stopTimers();
      ws = null;
      welcomed = false;
      if (closed) return;
      // The Hub refused the token: wait for a different one. Its other 1008s (a late or malformed hello) retry.
      if (ev?.code === 1008 && ev.reason === "unauthorized") {
        authFailedToken = next.token;
        return;
      }
      scheduleReconnect();
    });
    sock.addEventListener("error", () => {
      /* close follows */
    });
  }

  /** Connect when the Acervo is configured; follow a changed URL or token. Idempotent. */
  async function ensure() {
    closed = false;
    const s = await settings();
    const next = s?.url && s?.token ? { url: s.url, token: s.token } : null;
    if (!next) {
      disconnect();
      return;
    }
    const id = await instanceId();
    // Nothing awaits from here on: two wake-ups at once open one socket.
    if (ws && (ws.readyState === OPEN || ws.readyState === CONNECTING)) {
      if (target?.url === next.url && target?.token === next.token) return;
      disconnect();
      closed = false;
    }
    if (authFailedToken && authFailedToken === next.token) return;
    authFailedToken = null;
    connect(next, id);
  }

  function disconnect() {
    stopTimers();
    const sock = ws;
    ws = null;
    welcomed = false;
    try {
      sock?.close(1000, "closing");
    } catch {
      /* already closed */
    }
  }

  /** Close for good (until the next ensure). A job in progress keeps running and its result waits in storage. */
  function close() {
    closed = true;
    disconnect();
  }

  return {
    ensure,
    close,
    status: () => ({ connected: !!ws && ws.readyState === OPEN && welcomed, working: working?.taskId ?? null, authFailed: !!authFailedToken }),
  };
}
