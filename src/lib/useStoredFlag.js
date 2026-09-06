import { useCallback, useEffect, useState } from "react";

// A boolean that lives in chrome.storage.local and is followed while it is on
// screen. Two places now toggle the same page overlay — the tool's own toolbar
// and the panel-wide Opções modal — and each window has its own panel, so a
// switch that only wrote on mount would leave the other one showing the opposite
// of the truth until it was remounted.
//
// `fallback` is what an unset key means. The page overlays default to ON, so
// "never stored" and "stored true" have to read the same.
export default function useStoredFlag(key, fallback = true) {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    let dead = false;
    chrome.storage.local
      .get(key)
      .then((r) => {
        if (!dead && r?.[key] != null) setValue(!!r[key]);
      })
      .catch(() => {});
    const onCh = (changes, area) => {
      if (area !== "local" || !changes[key]) return;
      const next = changes[key].newValue;
      setValue(next == null ? fallback : !!next);
    };
    chrome.storage.onChanged?.addListener(onCh);
    return () => {
      dead = true;
      chrome.storage.onChanged?.removeListener(onCh);
    };
  }, [key, fallback]);

  // Optimistic: the switch flips now, storage catches up. The onChanged listener
  // above then confirms it (and is what carries the change to the other places
  // showing this same flag).
  const write = useCallback(
    (v) => {
      const next = !!v;
      setValue(next);
      try {
        chrome?.storage?.local?.set({ [key]: next });
      } catch {
        /* applied locally; only the cross-surface sync is lost */
      }
    },
    [key],
  );

  return [value, write];
}
