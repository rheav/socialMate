import { useCallback, useEffect, useState } from "react";
import { requireOk } from "./bg.js";
import { SPY_KEY, SPY_STATE_KEY, SPY_PREFS_KEY, SPY_QUEUE_KEY, autoOn, igLimit } from "./spyStore.js";
import { SPY_ACTIVITY_KEY, SPY_HUB_KEY } from "./spyActivity.js";
// @private
import { SYNC_KEY, isSyncConfigured, syncSettings } from "./syncClient.js";
// @end-private
// @public
import { SYNC_KEY, isSyncConfigured, syncSettings } from "../hub-local/settings.js";
// @end-public

export function useSpy() {
  const [stored, setStored] = useState({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [nextTickAt, setNextTickAt] = useState(null);
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    let dead = false;
    let ticket = 0;
    const keys = [SPY_KEY, SPY_STATE_KEY, SPY_QUEUE_KEY, SYNC_KEY, SPY_ACTIVITY_KEY, SPY_HUB_KEY, SPY_PREFS_KEY];
    // The automatic tick lives in chrome.alarms, not storage: read it with the
    // rest and every 15 s, so the panel can say when the next pass runs.
    const readAlarm = async () => {
      try {
        const alarm = await chrome.alarms?.get?.("fbw-spy-tick");
        if (!dead) setNextTickAt(alarm?.scheduledTime ?? null);
      } catch { /* alarms unavailable */ }
    };
    const load = async () => {
      const mine = ++ticket;
      readAlarm();
      try {
        const next = await chrome.storage.local.get(keys);
        if (!dead && mine === ticket) { setStored(next); setReady(true); }
      } catch { if (!dead) setError("Não consegui ler os perfis salvos."); }
    };
    let refreshing = false;
    const refresh = async () => {
      if (dead || refreshing || document.visibilityState !== "visible") return;
      refreshing = true;
      try {
        await requireOk({ type: "FBW_SPY_REFRESH_LIST" });
        if (!dead) setError(null);
      } catch {
        if (!dead) setError("Não consegui atualizar a lista. Os perfis salvos continuam disponíveis.");
      } finally { refreshing = false; }
    };
    // List sync is independent of daily measurements and only runs while visible.
    const alarmTimer = setInterval(() => { readAlarm(); refresh(); }, 15000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    const changed = (changes, area) => {
      if (area === "local" && keys.some((key) => changes[key])) load();
    };
    chrome.storage.onChanged.addListener(changed);
    load();
    refresh();
    return () => {
      dead = true; ticket++; clearInterval(alarmTimer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  return {
    profiles: Object.values(stored[SPY_KEY]?.profiles || {}).filter((p) => p.removedAt == null)
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)),
    state: stored[SPY_STATE_KEY] || {},
    queue: stored[SPY_QUEUE_KEY] || {},
    activity: stored[SPY_ACTIVITY_KEY] || [],
    hub: stored[SPY_HUB_KEY] || null,
    nextTickAt,
    dailyOff: !autoOn(stored[SPY_PREFS_KEY]),
    igLimit: igLimit(stored[SPY_PREFS_KEY]),
    configured: isSyncConfigured(syncSettings(stored[SYNC_KEY])),
    ready, error,
    save: (platform, key) => requireOk({ type: "FBW_SPY_SAVE", platform, key }),
    remove: (id) => requireOk({ type: "FBW_SPY_REMOVE", id }),
    measureProfile: (id) => requireOk({ type: "FBW_SPY_MEASURE_ONE", id }),
    runPass: () => requireOk({ type: "FBW_SPY_RUN" }),
  };
}

/** [auto, saveAuto, igLimit, saveIgLimit]: the Spy prefs (the routines switch and the Instagram cap), each save merged into the stored object. */
export function useSpyPrefs() {
  const [prefs, setPrefs] = useState({});
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    let dead = false;
    let changedSinceRead = false;
    const changed = (changes, area) => {
      if (area === "local" && changes[SPY_PREFS_KEY]) {
        changedSinceRead = true;
        setPrefs(changes[SPY_PREFS_KEY].newValue || {});
      }
    };
    chrome.storage.onChanged.addListener(changed);
    chrome.storage.local.get(SPY_PREFS_KEY).then((r) => {
      if (!dead && !changedSinceRead) setPrefs(r[SPY_PREFS_KEY] || {});
    }).catch(() => {});
    return () => { dead = true; chrome.storage.onChanged.removeListener(changed); };
  }, []);
  // The background follows this key: it schedules/cancels the daily alarm and
  // reads the Instagram cap at every step.
  const merge = useCallback(async (patch) => {
    const r = await chrome.storage.local.get(SPY_PREFS_KEY);
    const next = { ...(r[SPY_PREFS_KEY] || {}), ...patch };
    await chrome.storage.local.set({ [SPY_PREFS_KEY]: next });
    setPrefs(next);
  }, []);
  const saveDaily = useCallback((value) => merge({ daily: !!value }), [merge]);
  const saveIgLimit = useCallback((value) => merge({ igLimit: igLimit({ igLimit: value }) }), [merge]);
  return [autoOn(prefs), saveDaily, igLimit(prefs), saveIgLimit];
}
