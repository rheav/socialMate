import { useEffect, useState } from "react";
import { hubStatus } from "@/lib/hubStatus";
import { startPolling } from "@/lib/poll";
import { isSyncConfigured } from "@/lib/syncClient";
import { useSyncSettings } from "@/lib/useSyncSettings";

// The header's connection light for the Acervo (socialmate hub): green and
// breathing while the hub answers, amber when it doesn't. Not rendered at all when
// sync isn't configured — an install that never syncs (the probe profile) has no
// connection to report on.
//
// It pings every PING_MS while the panel is visible (startPolling skips hidden
// ticks) and also listens to the background's real syncs through fbw_sync_state;
// lib/hubStatus.js lets the most recent of the two decide the colour.
const PING_MS = 60_000;

export default function HubStatusDot({ onClick }) {
  const { settings, state, ready, ping } = useSyncSettings();
  const configured = ready && isSyncConfigured(settings);
  const [last, setLast] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setLast(null);
    if (!configured) return;
    return startPolling(async () => {
      const r = await ping();
      setLast({ at: Date.now(), ok: !!r?.ok, error: r?.error, status: r?.status });
      setNow(Date.now());
    }, PING_MS);
    // `ping` is recreated every render; the settings it reads are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, settings.url, settings.token]);

  const { tone, title } = hubStatus({ configured, ping: last, state, now });
  if (tone === "off") return null;
  return (
    <button
      onClick={onClick}
      // "verificado há 20 s" is only true at render time; refresh it on hover.
      onPointerEnter={() => setNow(Date.now())}
      title={title}
      aria-label={title}
      data-tone={tone}
      className="sw-hub-dot grid size-6 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="sw-hub-dot__core" aria-hidden="true" />
    </button>
  );
}
