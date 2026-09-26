import { useCallback, useEffect, useRef, useState } from "react";
import { emptyQuery, normalizeQuery, querySignature } from "@/lib/shared/feedQuery";

// The feed query (sort + filters) for one platform, living in chrome.storage.local
// and followed while on screen. The page's grid sorter (pageSorter.js, inside the
// Instagram bridge / TikTok relay) reads and writes the same key, so the panel's
// select and the bar on the page move together: sort in one, both reorder.
export default function useFeedQuery(storageKey, fields) {
  const [query, setQueryState] = useState(emptyQuery);
  const current = useRef(query);
  current.current = query;

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    let dead = false;
    chrome.storage.local
      .get(storageKey)
      .then((r) => {
        if (!dead) setQueryState(normalizeQuery(r?.[storageKey], fields));
      })
      .catch(() => {});
    const onCh = (changes, area) => {
      if (area !== "local" || !changes[storageKey]) return;
      const next = normalizeQuery(changes[storageKey].newValue, fields);
      setQueryState((cur) => (querySignature(cur) === querySignature(next) ? cur : next));
    };
    chrome.storage.onChanged?.addListener(onCh);
    return () => {
      dead = true;
      chrome.storage.onChanged?.removeListener(onCh);
    };
  }, [storageKey, fields]);

  // Optimistic, like useStoredFlag: the panel re-sorts now, storage (and with it
  // the page's grid) catches up.
  const setQuery = useCallback(
    (next) => {
      const q = normalizeQuery(typeof next === "function" ? next(current.current) : next, fields);
      current.current = q;
      setQueryState(q);
      try {
        chrome?.storage?.local?.set({ [storageKey]: q });
      } catch {
        /* applied in the panel; only the page sync is lost */
      }
    },
    [storageKey, fields],
  );

  return [query, setQuery];
}
