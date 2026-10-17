// Presence beacon for the Instagram Scraper backends.
//
// Same protocol as the old bridge's relay.js (`/ws/extension-relay`): a hello
// with the ingest token, pings, and the extension's own counters. Captures do
// not travel here; the socket only lets a backend (and Relay App, through it)
// tell an idle extension from a missing one. Identified as
// `socialmate-extension` so the backend can tell it from the old bridge.
//
// Timers live only while the worker lives. What brings the beacon back after
// the worker dies is the persisted destination list plus `ensure()` on wake and
// on the one-minute alarm.

export const IG_RELAY_PATH = "/ws/extension-relay";
const PING_MS = 20_000;
const STATS_MS = 30_000;
const STALE_MS = 60_000;
const BASE_MS = 2_000;
const MAX_MS = 60_000;

/** Exponential backoff with jitter, kept within 2–60 s. */
export function reconnectDelay(attempt, random = Math.random) {
  const raw = Math.min(MAX_MS, BASE_MS * 2 ** Math.max(0, attempt));
  const jittered = raw * (0.75 + 0.25 * random());
  return Math.round(Math.min(MAX_MS, Math.max(BASE_MS, jittered)));
}

export function relayUrl(httpUrl) {
  return String(httpUrl).replace(/\/+$/, "").replace(/^http/, "ws") + IG_RELAY_PATH;
}

/**
 * @param {object} deps
 * @param {typeof WebSocket} deps.WebSocketImpl
 * @param {() => Promise<Array<{id,url,token}>>} deps.destinations enabled destinations
 * @param {(id) => Promise<{queueLen,sent,failed,lastError}>} deps.stats
 * @param {string} deps.version
 */
export function createIgPresence({ WebSocketImpl, destinations, stats, version, ua = "", random = Math.random }) {
  if (!WebSocketImpl) return { ensure: async () => {}, disconnectAll() {}, status: () => [] };
  const OPEN = WebSocketImpl.OPEN ?? 1;
  const CONNECTING = WebSocketImpl.CONNECTING ?? 0;
  const conns = new Map(); // id → { target, ws, attempt, timers…, authFailedToken, lastHeardAt }

  function clearTimers(entry) {
    clearInterval(entry.ping);
    clearInterval(entry.stats);
    clearInterval(entry.watch);
    clearTimeout(entry.retry);
    entry.ping = entry.stats = entry.watch = entry.retry = null;
  }

  async function sendStats(entry) {
    if (entry.ws?.readyState !== OPEN) return;
    const s = await stats(entry.target.id).catch(() => null);
    if (!s || entry.ws?.readyState !== OPEN) return;
    entry.ws.send(
      JSON.stringify({ type: "stats", queueLen: s.queueLen || 0, sent: s.sent || 0, failed: s.failed || 0, lastError: s.lastError || "" }),
    );
  }

  function scheduleReconnect(entry) {
    clearTimeout(entry.retry);
    const delay = reconnectDelay(entry.attempt, random);
    entry.attempt += 1;
    entry.retry = setTimeout(() => {
      entry.retry = null;
      if (conns.get(entry.target.id) === entry) connect(entry);
    }, delay);
  }

  function connect(entry) {
    if (entry.ws && (entry.ws.readyState === OPEN || entry.ws.readyState === CONNECTING)) return;
    clearTimers(entry);
    let ws;
    try {
      ws = new WebSocketImpl(relayUrl(entry.target.url));
    } catch {
      scheduleReconnect(entry);
      return;
    }
    entry.ws = ws;
    entry.lastHeardAt = Date.now();

    ws.addEventListener("open", () => {
      entry.attempt = 0;
      entry.lastHeardAt = Date.now();
      ws.send(JSON.stringify({ type: "hello", token: entry.target.token, id: "socialmate-extension", version, ua }));
      entry.ping = setInterval(() => {
        if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: "ping", at: Date.now() }));
      }, PING_MS);
      entry.stats = setInterval(() => sendStats(entry).catch(() => {}), STATS_MS);
      // An open socket the server stopped answering looks alive to readyState;
      // the server pings every 20 s, so a minute of silence means it is gone.
      entry.watch = setInterval(() => {
        if (Date.now() - entry.lastHeardAt >= STALE_MS) {
          try {
            ws.close(4000, "stale");
          } catch {
            /* close fires and owns the retry */
          }
        }
      }, PING_MS);
      sendStats(entry).catch(() => {});
    });

    ws.addEventListener("message", (ev) => {
      entry.lastHeardAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.type === "ping" && ws.readyState === OPEN) ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
    });

    ws.addEventListener("close", (ev) => {
      clearTimers(entry);
      if (entry.ws === ws) entry.ws = null;
      if (conns.get(entry.target.id) !== entry) return; // destination removed
      // 1008 = the backend refused the token. Retrying would only log-spam it;
      // wait until the token changes.
      if (ev?.code === 1008) {
        entry.authFailedToken = entry.target.token;
        return;
      }
      scheduleReconnect(entry);
    });

    ws.addEventListener("error", () => {
      /* close follows and owns the retry */
    });
  }

  function drop(id) {
    const entry = conns.get(id);
    if (!entry) return;
    conns.delete(id);
    clearTimers(entry);
    try {
      entry.ws?.close(1000, "destination removed");
    } catch {
      /* already closed */
    }
  }

  /** Open sockets for the enabled destinations, close the rest. Idempotent. */
  async function ensure() {
    const targets = await destinations();
    const wanted = new Map(targets.map((t) => [t.id, t]));
    for (const id of [...conns.keys()]) {
      const t = wanted.get(id);
      const entry = conns.get(id);
      if (!t || t.url !== entry.target.url) drop(id);
    }
    for (const target of targets) {
      let entry = conns.get(target.id);
      if (!entry) {
        entry = { target, ws: null, attempt: 0, authFailedToken: null, lastHeardAt: 0 };
        conns.set(target.id, entry);
      }
      entry.target = target;
      if (entry.authFailedToken && entry.authFailedToken === target.token) continue;
      entry.authFailedToken = null;
      if (entry.retry) continue; // a reconnect is already scheduled
      connect(entry);
    }
  }

  function disconnectAll() {
    for (const id of [...conns.keys()]) drop(id);
  }

  function status() {
    return [...conns.values()].map((e) => ({
      id: e.target.id,
      connected: e.ws?.readyState === OPEN,
      authFailed: !!e.authFailedToken,
      attempt: e.attempt,
    }));
  }

  return { ensure, disconnectAll, status };
}
