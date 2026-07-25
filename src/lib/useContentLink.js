import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { resolvePlatformTab, hasChromeTabs } from "@/lib/tabs";
import {
  INITIAL_LINK,
  LINK_NO_TAB,
  LINK_UNREACHABLE,
  PLATFORM_HOME,
  nextLinkState,
} from "@/lib/contentLink";

// The background writes this on every tabs.onActivated ping of an FB/IG tab.
const NEED_RELOAD_KEY = "fbw_need_reload";
// ...and ONLY for those two hosts, so reading it on a TikTok or Pinterest panel
// would raise a banner there because a stale Facebook tab was focused once.
const PINGED_PLATFORMS = new Set(["facebook", "instagram"]);

const hasStorage = () =>
  typeof chrome !== "undefined" && !!chrome?.storage?.local;
const hasRuntime = () =>
  typeof chrome !== "undefined" && !!chrome?.runtime?.sendMessage;

/**
 * The ONE way a tool panel talks to its platform's content script.
 *
 * Replaces the per-panel `try { sendMessage } catch { return null }`: the caller
 * still gets `null` on failure (so existing `if (res)` guards keep working), but
 * the failure is now recorded in `link` and rendered by ContentLinkBanner —
 * with a button that actually repairs the tab.
 *
 * Returns:
 *   link          state for <ContentLinkBanner>
 *   noTab         no tab of this platform is open
 *   unreachable   a tab is open but its content script is silent
 *   fixing        a recovery attempt is in flight
 *   send(msg, {userAction, action})   → response | null
 *   revive()      re-inject (else reload) the bound tab
 *   openTab()     open the platform in a new tab
 *   ensureTab()   resolve the bound tab id, reporting "no tab" if there is none
 *   tabId         ref to the bound tab id (for chrome.windows.create & friends)
 */
export function useContentLink(platform) {
  const [link, dispatch] = useReducer(nextLinkState, INITIAL_LINK);
  const [fixing, setFixing] = useState(false);
  const tabId = useRef(null);
  // Mirrored in a ref so `send` can clear a stale flag without taking `link` as
  // a dependency — `send` feeds startPolling, and a new identity every render
  // would restart every poll loop in the panel.
  const flagged = useRef(false);
  useEffect(() => {
    flagged.current = link.flagged;
  }, [link.flagged]);

  // A platform switch invalidates the bound tab and everything learned about it.
  useEffect(() => {
    tabId.current = null;
    dispatch({ kind: "reset" });
  }, [platform]);

  useEffect(() => {
    if (!hasStorage() || !PINGED_PLATFORMS.has(platform)) return;
    let dead = false;
    // `initial: true` — a value of unknown age; it is recorded so a successful
    // send can clear it, but it does not raise the banner by itself. See the
    // "flag" case in contentLink.js.
    chrome.storage.local.get(NEED_RELOAD_KEY, (r) => {
      if (!dead)
        dispatch({ kind: "flag", value: !!r?.[NEED_RELOAD_KEY], initial: true });
    });
    const onChanged = (c, area) => {
      if (area === "local" && c[NEED_RELOAD_KEY])
        dispatch({ kind: "flag", value: !!c[NEED_RELOAD_KEY].newValue });
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      dead = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [platform]);

  // Only written when the flag is actually set — a successful send happens once
  // a second per polling panel and must not turn into a storage write loop.
  const clearFlag = useCallback(() => {
    if (!flagged.current) return;
    flagged.current = false;
    if (hasStorage()) chrome.storage.local.set({ [NEED_RELOAD_KEY]: false });
  }, []);

  const ensureTab = useCallback(async () => {
    if (!hasChromeTabs()) {
      dispatch({ kind: "no-tab" });
      return null;
    }
    if (tabId.current == null) tabId.current = await resolvePlatformTab(platform);
    if (tabId.current == null) dispatch({ kind: "no-tab" });
    return tabId.current;
  }, [platform]);

  const send = useCallback(
    async (msg, { userAction = false, action = null } = {}) => {
      if (!hasChromeTabs()) {
        dispatch({ kind: "no-tab", action: userAction ? action : null });
        return null;
      }
      if (tabId.current == null)
        tabId.current = await resolvePlatformTab(platform);
      if (tabId.current == null) {
        dispatch({ kind: "no-tab", action: userAction ? action : null });
        return null;
      }
      try {
        const res = await chrome.tabs.sendMessage(tabId.current, msg);
        dispatch({ kind: "ok" });
        clearFlag();
        return res;
      } catch (e) {
        // Drop the binding so the next call re-resolves — the tab may have been
        // closed or replaced. Every panel already did this; what none of them
        // did was tell anybody it had happened.
        tabId.current = null;
        dispatch({
          kind: "miss",
          error: e?.message || String(e),
          userAction,
          action: userAction ? action : null,
        });
        return null;
      }
    },
    [platform, clearFlag],
  );

  const revive = useCallback(async () => {
    if (!hasChromeTabs()) return false;
    setFixing(true);
    try {
      const id = tabId.current ?? (await resolvePlatformTab(platform));
      if (id == null) {
        dispatch({ kind: "no-tab" });
        return false;
      }
      tabId.current = id;
      // The service worker owns the manifest → executeScript mapping
      // (reinjectContentScripts, including the MAIN/ISOLATED world choice), so
      // recovery is delegated there rather than duplicated here. It re-injects
      // first — the page keeps its scroll position and any half-typed comment —
      // and only reloads if injection can't reach the tab.
      const res = hasRuntime()
        ? await chrome.runtime
            .sendMessage({ type: "FBW_REVIVE_TAB", tabId: id })
            .catch(() => null)
        : null;
      if (res?.ok) {
        dispatch({ kind: "ok" });
        clearFlag();
        return true;
      }
      // No answer at all means an old or asleep service worker: reloading the
      // tab is the blunt instrument that always works, and the panel's poll
      // picks the repaired tab up from there.
      try {
        await chrome.tabs.reload(id);
        dispatch({ kind: "reset" });
        return true;
      } catch (e) {
        dispatch({
          kind: "miss",
          error: res?.error || e?.message || String(e),
          userAction: true,
        });
        return false;
      }
    } finally {
      setFixing(false);
    }
  }, [platform, clearFlag]);

  const openTab = useCallback(async () => {
    const url = PLATFORM_HOME[platform];
    if (!url || typeof chrome === "undefined" || !chrome?.tabs?.create)
      return false;
    setFixing(true);
    try {
      const t = await chrome.tabs.create({ url, active: true });
      tabId.current = t?.id ?? null;
      // Freshly created tab: its content scripts run on load, so start clean and
      // let the poll confirm rather than leaving the old banner up.
      dispatch({ kind: "reset" });
      return true;
    } catch {
      return false;
    } finally {
      setFixing(false);
    }
  }, [platform]);

  return {
    link,
    status: link.status,
    noTab: link.status === LINK_NO_TAB,
    unreachable: link.status === LINK_UNREACHABLE,
    fixing,
    send,
    revive,
    openTab,
    ensureTab,
    tabId,
  };
}

export default useContentLink;
