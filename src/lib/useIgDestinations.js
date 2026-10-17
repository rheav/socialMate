// Opções' view of the Instagram Scraper destinations: the stored settings, what
// the worker reports about each one (pending, refused, last error, presence),
// and the two actions (test, send now). Host permissions follow useSyncSettings:
// asked for from the click that needs them.
import { useCallback, useEffect, useState } from "react";
import { IG_DESTINATIONS_KEY, igDestinationSettings } from "./igDestinations.js";
import { IG_DELIVERY_KEY, IG_OUTBOX_KEY } from "./igOutbox.js";
import { originPattern } from "./useSyncSettings.js";
import { sendBg } from "./bg.js";

const hasStorage = () => typeof chrome !== "undefined" && !!chrome?.storage?.local;

export function useIgDestinations() {
  const [settings, setSettings] = useState(() => igDestinationSettings(null));
  const [status, setStatus] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!hasStorage()) return;
    let alive = true;
    const load = () => {
      chrome.storage.local.get(IG_DESTINATIONS_KEY, (r) => {
        if (!alive) return;
        setSettings(igDestinationSettings(r[IG_DESTINATIONS_KEY]));
        setReady(true);
      });
      sendBg({ type: "FBW_IG_EXPORT_STATUS" })
        .then((res) => alive && res?.ok && setStatus(res.status))
        .catch(() => {});
    };
    load();
    const onCh = (c, area) => {
      if (area !== "local") return;
      if (c[IG_DESTINATIONS_KEY] || c[IG_DELIVERY_KEY] || c[IG_OUTBOX_KEY]) load();
    };
    chrome.storage.onChanged.addListener(onCh);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onCh);
    };
  }, []);

  const save = useCallback(
    (id, patch) => {
      const next = igDestinationSettings({ ...settings, [id]: { ...settings[id], ...patch } });
      setSettings(next); // optimistic: the storage round-trip would lag typing
      return chrome.storage.local.set({ [IG_DESTINATIONS_KEY]: next });
    },
    [settings],
  );

  const ensureHost = useCallback(async (url) => {
    const origins = originPattern(url);
    if (!origins || !chrome?.permissions) return true;
    if (await chrome.permissions.contains({ origins: [origins] })) return true;
    return chrome.permissions.request({ origins: [origins] });
  }, []);

  return {
    settings,
    status,
    ready,
    save,
    ensureHost,
    test: (id) => sendBg({ type: "FBW_IG_EXPORT_TEST", id }),
    flush: () => sendBg({ type: "FBW_IG_EXPORT_FLUSH" }),
  };
}
