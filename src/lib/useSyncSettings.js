// The Opções screen's view of hub sync: the stored settings, the last result the
// background wrote, and the three things the user can ask for (test, push
// everything, turn it on).
//
// Permissions are part of this on purpose. The manifest ships one granted host —
// the hub the extension is built for — so pointing the sync somewhere else has to
// ask, and it has to ask from the click that asked for it (Chrome requires a user
// gesture). Doing it anywhere else means a "testar" button that silently fails
// with a CORS-shaped error nobody can act on.
import { useCallback, useEffect, useState } from "react";
import { SYNC_KEY, SYNC_STATE_KEY, syncSettings } from "./syncClient.js";
import { sendBg } from "./bg.js";

const hasStorage = () => typeof chrome !== "undefined" && !!chrome?.storage?.local;

export function originPattern(url) {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return null;
  }
}

export function useSyncSettings() {
  const [settings, setSettings] = useState(() => syncSettings(null));
  const [state, setState] = useState({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!hasStorage()) return;
    const load = () =>
      chrome.storage.local.get([SYNC_KEY, SYNC_STATE_KEY], (r) => {
        setSettings(syncSettings(r[SYNC_KEY]));
        setState(r[SYNC_STATE_KEY] || {});
        setReady(true);
      });
    load();
    const onCh = (c, area) => {
      if (area !== "local") return;
      if (c[SYNC_KEY] || c[SYNC_STATE_KEY]) load();
    };
    chrome.storage.onChanged.addListener(onCh);
    return () => chrome.storage.onChanged.removeListener(onCh);
  }, []);

  const save = useCallback(
    (patch) => {
      const next = syncSettings({ ...settings, ...patch });
      setSettings(next); // optimistic: the storage round-trip would lag typing
      return chrome.storage.local.set({ [SYNC_KEY]: next });
    },
    [settings],
  );

  /** Ask for the host if it is not the one the manifest already grants. */
  const ensureHost = useCallback(async (url) => {
    const origins = originPattern(url);
    if (!origins || !chrome?.permissions) return true;
    if (await chrome.permissions.contains({ origins: [origins] })) return true;
    return chrome.permissions.request({ origins: [origins] });
  }, []);

  return { settings, state, ready, save, ensureHost, ping: () => sendBg({ type: "FBW_SYNC_PING" }), syncAll: () => sendBg({ type: "FBW_SYNC_ALL" }) };
}
