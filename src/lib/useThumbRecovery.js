// The Arquivo's side of thumbnail recovery: how many cards are broken, a way to
// repair them, and live progress while the background works through the list.
//
// Two sources of "broken": the stored URL's own expiry stamp (free, no request —
// see lib/thumbCache.js) and an <img> that actually failed to load, which is the
// only way to catch a link that died without a stamp (deleted media, a rotated
// signature, Pinterest). The second kind is remembered for the session only; a
// card that failed once does not stop failing because the panel was reopened,
// it simply gets re-detected on the next render.
import { useCallback, useEffect, useMemo, useState } from "react";
import { recoverableRecords } from "./thumbRecover.js";
import { sendBg } from "./bg.js";

const IDLE = { running: false, done: 0, total: 0, fixed: 0, failed: 0 };

export function useThumbRecovery(records) {
  const [broken, setBroken] = useState(() => new Set());
  const [sweep, setSweep] = useState(IDLE);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.runtime?.onMessage) return;
    // A panel opened mid-sweep missed every progress message so far.
    sendBg({ type: "FBW_THUMB_STATUS" }).then((r) => {
      if (r && r.ok) setSweep({ running: !!r.running, done: r.done, total: r.total, fixed: r.fixed, failed: r.failed });
    });
    const onMsg = (msg) => {
      if (msg?.type !== "FBW_THUMB_PROGRESS") return;
      setSweep({ running: !!msg.running, done: msg.done, total: msg.total, fixed: msg.fixed, failed: msg.failed });
      // A repaired record arrives through storage.onChanged like any other write;
      // clearing the broken marks lets those cards count as healthy again.
      if (!msg.running) setBroken(new Set());
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  const markBroken = useCallback((id) => {
    if (!id) return;
    setBroken((s) => (s.has(String(id)) ? s : new Set(s).add(String(id))));
  }, []);

  const pending = useMemo(
    () => recoverableRecords(records, { brokenIds: broken }).length,
    [records, broken],
  );

  const start = useCallback(
    () => sendBg({ type: "FBW_THUMB_RECOVER", brokenIds: Array.from(broken) }),
    [broken],
  );

  return { pending, sweep, markBroken, start };
}
