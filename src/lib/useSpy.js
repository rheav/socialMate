import { useCallback, useEffect, useState } from "react";
import { requireOk } from "./bg.js";
import { SPY_KEY, SPY_STATE_KEY, SPY_PREFS_KEY } from "./spyStore.js";
import { SYNC_KEY, isSyncConfigured, syncSettings } from "./syncClient.js";

export function useSpy() {
  const [stored, setStored] = useState({});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    let dead = false;
    let ticket = 0;
    const keys = [SPY_KEY, SPY_STATE_KEY, SYNC_KEY];
    const load = async () => {
      const mine = ++ticket;
      try {
        const next = await chrome.storage.local.get(keys);
        if (!dead && mine === ticket) { setStored(next); setReady(true); }
      } catch { if (!dead) setError("Não consegui ler os perfis salvos."); }
    };
    const changed = (changes, area) => {
      if (area === "local" && keys.some((key) => changes[key])) load();
    };
    chrome.storage.onChanged.addListener(changed);
    load();
    requireOk({ type: "FBW_SPY_REFRESH_LIST" }).catch(() => {
      if (!dead) setError("Não consegui atualizar a lista. Os perfis salvos continuam disponíveis.");
    });
    return () => { dead = true; ticket++; chrome.storage.onChanged.removeListener(changed); };
  }, []);
  return {
    profiles: Object.values(stored[SPY_KEY]?.profiles || {}).filter((p) => p.removedAt == null)
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)),
    state: stored[SPY_STATE_KEY] || {},
    configured: isSyncConfigured(syncSettings(stored[SYNC_KEY])),
    ready, error,
    save: (platform, key) => requireOk({ type: "FBW_SPY_SAVE", platform, key }),
    remove: (id) => requireOk({ type: "FBW_SPY_REMOVE", id }),
    runPass: () => requireOk({ type: "FBW_SPY_RUN" }),
  };
}

export function useSpyPrefs() {
  const [daily, setDaily] = useState(true);
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    let dead = false;
    let changedSinceRead = false;
    const changed = (changes, area) => {
      if (area === "local" && changes[SPY_PREFS_KEY]) {
        changedSinceRead = true;
        setDaily(changes[SPY_PREFS_KEY].newValue?.daily !== false);
      }
    };
    chrome.storage.onChanged.addListener(changed);
    chrome.storage.local.get(SPY_PREFS_KEY).then((r) => {
      if (!dead && !changedSinceRead) setDaily(r[SPY_PREFS_KEY]?.daily !== false);
    }).catch(() => {});
    return () => { dead = true; chrome.storage.onChanged.removeListener(changed); };
  }, []);
  const save = useCallback(async (value) => {
    // The background follows this key and schedules/cancels the daily alarm.
    await chrome.storage.local.set({ [SPY_PREFS_KEY]: { daily: !!value } });
    setDaily(!!value);
  }, []);
  return [daily, save];
}
