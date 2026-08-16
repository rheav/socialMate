// The panel's live link to the video playing in the tab.
//
// Opens a port to the active Facebook/Instagram/TikTok tab's content script,
// which publishes {videoId, t, paused} on every `timeupdate` (~3.8×/s measured).
// Returns that tick plus a `seek(videoId, t)` that pushes back down the same port.
//
// A port, not polling: the page already has the events, and a one-shot
// sendMessage round trip (0.4-0.9 ms measured) per tick would still burn a
// message per 265 ms for no gain.
//
// Rebinds when the user switches tabs — a second FB tab playing in the background
// must never drive the highlight.
import { useEffect, useRef, useState } from "react";

const MEDIA_TABS = ["*://*.facebook.com/*", "*://*.instagram.com/*", "*://*.tiktok.com/*"];
const PORT_NAME = "fbw-playhead";

const canTabs = () => typeof chrome !== "undefined" && !!chrome?.tabs?.connect;

export function usePlayhead() {
  const [tick, setTick] = useState(null); // { videoId, t, paused, duration } | null
  const portRef = useRef(null);

  useEffect(() => {
    if (!canTabs()) return;
    let stopped = false;

    const drop = () => {
      try { portRef.current?.disconnect(); } catch {}
      portRef.current = null;
    };

    // Every bind gets a ticket. Two triggers can interleave — tabs.onActivated and
    // an SPA tabs.onUpdated fire together on FB/IG all the time — and both used to
    // pass drop() while portRef was still null, open a port, and leave the LOSER
    // connected forever: its onDisconnect guard (portRef.current === port) never
    // matched, so nothing ever cleaned it up, and its onMessage kept driving the
    // highlight from whatever tab it was bound to.
    let ticket = 0;

    const bind = async () => {
      if (stopped) return;
      const mine = ++ticket;
      drop();
      setTick(null);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      if (stopped || mine !== ticket) return; // a newer bind owns the port now
      if (!tab?.id || !/facebook\.com|instagram\.com|tiktok\.com/.test(tab.url || "")) return;
      let port;
      try {
        port = chrome.tabs.connect(tab.id, { name: PORT_NAME });
      } catch {
        return; // no content script in that tab (not injected yet, or a stale tab)
      }
      // Lost the race while connecting: disconnect immediately rather than leaving
      // a second live port pushing ticks into the same component.
      if (stopped || mine !== ticket) {
        try { port.disconnect(); } catch {}
        return;
      }
      port.onMessage.addListener((msg) => {
        // `portRef.current === port` and not just `!stopped`: only the port this
        // hook is currently bound to may move the highlight. A port that has been
        // superseded must go quiet even in the window before it disconnects.
        if (!stopped && portRef.current === port && msg && typeof msg.t === "number")
          setTick(msg);
      });
      port.onDisconnect.addListener(() => {
        // Reading lastError keeps Chrome from logging "Receiving end does not
        // exist" for tabs where the content script never loaded.
        void chrome.runtime.lastError;
        if (portRef.current === port) {
          portRef.current = null;
          if (!stopped) setTick(null);
        }
      });
      portRef.current = port;
    };

    bind();
    const onActivated = () => bind();
    // Only a real navigation matters; ignore the noisy status/title updates.
    const onUpdated = (_id, change, tab) => { if (change.url && tab.active) bind(); };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      stopped = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      drop();
    };
  }, []);

  const seek = (videoId, t) => {
    try { portRef.current?.postMessage({ type: "seek", videoId, t }); } catch {}
  };

  return { tick, seek, live: !!tick };
}
