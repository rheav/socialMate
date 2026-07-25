import { useCallback, useEffect, useRef, useState } from "react";
import { resolvePlatformTab } from "@/lib/tabs";
import { startPolling } from "@/lib/poll";

// Pinterest Board tool. Unlike the IG/TT tools this is not polling a passive
// capture — pin-api.js actively pages Pinterest's resource API, so the panel asks
// for context once per surface and then drives an explicit Harvest.
export default function PinBoardTool() {
  const [ctx, setCtx] = useState(null);
  const [noTab, setNoTab] = useState(false);
  const tabId = useRef(null);

  const send = useCallback(async (msg) => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("pinterest");
    if (tabId.current == null) { setNoTab(true); return null; }
    setNoTab(false);
    try {
      return await chrome.tabs.sendMessage(tabId.current, msg);
    } catch {
      tabId.current = null;
      return null;
    }
  }, []);

  const loadContext = useCallback(async () => {
    const res = await send({ type: "FBW_PIN_CONTEXT" });
    if (res) setCtx(res);
  }, [send]);

  useEffect(() => {
    loadContext();
    // Context is cheap but not free (2 API calls), so re-check on a slow interval
    // to catch SPA navigation between boards rather than the 2.5s data-tool cadence.
    // startPolling (house pattern, see TtCollectionsTool) skips ticks while the panel
    // is hidden and fires once immediately on becoming visible.
    return startPolling(loadContext, 5000);
  }, [loadContext]);

  if (noTab)
    return <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">Open Pinterest in a tab (logged in), then reopen this panel.</div>;

  if (!ctx) return <p className="py-8 text-center text-sm text-muted-foreground">Reading the page…</p>;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="text-[13px] font-medium">{ctx.board?.name || ctx.surface?.kind}</div>
        <div className="text-[11px] text-muted-foreground">
          surface: {ctx.surface?.kind} · board: {ctx.board?.id || "—"} · pins: {ctx.board?.pin_count ?? "—"} · sections: {ctx.sections?.length ?? 0}
        </div>
        {ctx.error ? <div className="mt-1 text-[11px] text-red-600">{ctx.error}</div> : null}
      </div>
    </div>
  );
}
