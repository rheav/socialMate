import { useCallback, useEffect, useRef, useState } from "react";
import { requireOk } from "./bg.js";

// Per-item action status for the tool panes.
//
// Replaces the `const [busy, setBusy] = useState({})` + `setStatus(id, s)` pair
// that every pane carried, and fixes two things those copies got wrong:
//
//   1. The status was a bare string, so a failure's REASON was thrown away — the
//      panes' `catch { setStatus(id, "error") }` painted an icon red and the user
//      never learned why. `errorOf(key)` keeps the message for the tooltip.
//   2. Every action on a record shared ONE key, so a failed *thumbnail* download
//      painted the neighbouring media-download icon red. Keys are per action:
//      `key(rec.id)` for the media, `key(rec.id, "thumb")` for the cover.
//
// Deliberately not a download-specific hook: panes drive saves and exports
// through it too, and `run` takes any async function so a multi-request action
// (carousel, "download all") is one status.

// How long a terminal status stays on screen. They fade on their own because a
// grid that keeps every past outcome coloured stops describing anything current;
// "error" lingers far longer than "done" since its tooltip carries a reason the
// user still has to read. "downloading" is absent on purpose — it is not
// terminal, it ends when the action ends.
const EXPIRE_MS = { done: 2500, error: 12000 };

export function useItemStatus() {
  const [items, setItems] = useState({});
  const timers = useRef({});
  const alive = useRef(true);

  const drop = useCallback((key) => {
    if (!alive.current) return;
    setItems((m) => {
      if (!(key in m)) return m;
      const next = { ...m };
      delete next[key];
      return next;
    });
  }, []);

  const cancelExpiry = useCallback((key) => {
    const t = timers.current[key];
    if (t === undefined) return;
    clearTimeout(t);
    delete timers.current[key];
  }, []);

  const set = useCallback(
    (key, status, error = null) => {
      if (!alive.current) return;
      // A new status supersedes the old one, expiry included: without this a
      // re-run's "downloading" would still be wiped by the previous "done".
      cancelExpiry(key);
      setItems((m) => ({ ...m, [key]: { status, error } }));
      const ms = EXPIRE_MS[status];
      if (ms === undefined) return;
      timers.current[key] = setTimeout(() => {
        delete timers.current[key];
        drop(key);
      }, ms);
    },
    [cancelExpiry, drop],
  );

  const clear = useCallback(
    (key) => {
      cancelExpiry(key);
      drop(key);
    },
    [cancelExpiry, drop],
  );

  useEffect(() => {
    // Re-armed here, not just at init: StrictMode's mount/unmount/remount would
    // otherwise leave the hook permanently dead after the first cleanup.
    alive.current = true;
    return () => {
      alive.current = false;
      for (const t of Object.values(timers.current)) clearTimeout(t);
      timers.current = {};
    };
  }, []);

  // Run an async action, tracking busy → done | error with the real message.
  const run = useCallback(
    async (key, fn) => {
      set(key, "downloading");
      try {
        const out = await fn();
        set(key, "done");
        return out;
      } catch (e) {
        set(key, "error", String(e?.message || e) || "falhou");
        return null;
      }
    },
    [set],
  );

  // The common case: one background message, failing loudly when !ok.
  const send = useCallback((key, msg) => run(key, () => requireOk(msg)), [run]);

  const statusOf = useCallback((key) => items[key]?.status || null, [items]);
  const errorOf = useCallback((key) => items[key]?.error || null, [items]);

  return { items, run, send, set, clear, statusOf, errorOf };
}

// Composite status key. `useItemStatus.key(id)` is the record's primary action;
// pass an action name for anything else on the same record.
export function statusKey(id, action) {
  return action ? `${id}:${action}` : String(id);
}

// Tooltip text for a button: the failure reason when there is one, else the
// button's normal label. Keeps the "why" one hover away instead of nowhere.
export function statusTitle(label, status, error) {
  if (status === "error") return error ? `Falhou: ${error}` : `${label} — falhou`;
  return label;
}
