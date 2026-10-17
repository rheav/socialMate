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
/** After this many failed connects in a row, try every five minutes. */
const SLOW_AFTER = 6;
const SLOW_MS = 5 * 60_000;

export function analysisWsUrl(httpUrl) {
  return String(httpUrl).replace(/\/+$/, "").replace(/^http/, "ws") + ANALYSIS_WS_PATH;
}

/**
 * @param {object} deps
 * @param {typeof WebSocket} deps.WebSocketImpl
 * @param {() => Promise<{url,token}|null>} deps.settings  the Acervo sync settings
 * @param {{get,set}} deps.storage  chrome.storage.local
 * @param {{ preparePost(job, {progress}), cancelPrepare(taskId) }} deps.collect
 */
export function createAnalysisRelay({ WebSocketImpl, settings, storage, collect, version, random = Math.random }) {
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
    const delay = attempt >= SLOW_AFTER ? SLOW_MS : reconnectDelay(attempt, random);
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
    const progress = (code) => send({ type: "progress", taskId: task.taskId, leaseToken: task.leaseToken, code });
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

  async function onMessage(raw) {
    lastHeardAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg?.type) {
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

  async function connect(next) {
    const id = await instanceId();
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
      sock.send(JSON.stringify({ type: "hello", role: "extension", token: next.token, instanceId: id, version, capabilities: { collect: true } }));
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
      // 1008: the Hub refused the token. Wait for a different one.
      if (ev?.code === 1008) {
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
    if (ws && (ws.readyState === OPEN || ws.readyState === CONNECTING)) {
      if (target?.url === next.url && target?.token === next.token) return;
      disconnect();
      closed = false;
    }
    if (authFailedToken && authFailedToken === next.token) return;
    authFailedToken = null;
    if (retry) return;
    await connect(next);
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
