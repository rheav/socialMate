import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Square, RotateCw, FileArchive } from "lucide-react";
import { ToolBar, ActionButton } from "@/components/ui/ToolBar";
import { resolvePlatformTab } from "@/lib/tabs";
import { startPolling } from "@/lib/poll";
import {
  summarize,
  selectForZip,
  unresolvedManifest,
  UNRESOLVED_ENTRY,
  capMessage,
  zipNotes,
  filenameFor,
  extFromUrl,
  zipFilename,
  fmtBytes,
  photoPermalink,
} from "@/lib/fbPhotos";
import { ZipBuilder } from "@/lib/zipWriter";

// WHY the archive is assembled HERE and not in the service worker: an MV3 service
// worker has no URL.createObjectURL, so it cannot hand chrome.downloads a blob at
// all — background.js works around that for single images by base64-ing them into
// a data: URL (see its FBW_DL_MEDIA handler), which costs ~33% inflation and a
// full string copy per file. That is fine for one photo and untenable for two
// hundred. The side panel is an ordinary extension page: it has createObjectURL,
// it has chrome.downloads, and because *://*.fbcdn.net/* is in host_permissions
// its fetch() of a photo bypasses page CORS. Verified live: an extension-page
// fetch of a signed scontent URL returns 200 image/jpeg.
//
// WHAT IT DOWNLOADS: `rec.full`, the `viewer_image.uri` the MAIN-world capture
// read out of Facebook's own GraphQL traffic — the UNCROPPED photo. The grid
// tile's `rec.thumb` is a square crop and is only ever rendered as a preview
// here; it is never a download fallback. See src/lib/fbPhotos.js.

// Caps. Both are shown in the UI whenever they bite — this tool never truncates
// silently. 150 photos at Facebook's viewer resolution is roughly 30–80 MB; the
// byte budget is the real guard, since the count says nothing about size.
const MAX_ZIP_PHOTOS = 150;
const MAX_ZIP_BYTES = 400 * 1024 * 1024;
// Same 400 ms serial gap as IgSortTool / TtSortTool / PinBoardTool: Chrome will
// happily run these in parallel, but fbcdn starts refusing under a burst.
const FETCH_GAP_MS = 400;

const TEXT = new TextEncoder();

// One tile's whole story in a hover string.
function tileTitle(rec) {
  if (rec.full) return `${rec.width || "?"}×${rec.height || "?"} — foto inteira · abrir no Facebook`;
  return "sem a imagem inteira: só a miniatura recortada da grade · abrir no Facebook";
}

export default function FbPhotosTool() {
  const [ctx, setCtx] = useState(null);
  const [noTab, setNoTab] = useState(false);
  const tabId = useRef(null);

  const [records, setRecords] = useState([]);
  const [state, setState] = useState({ scraping: false, phase: "idle", scrolls: 0, hitCap: false, capReason: null, error: null, owner: null, caps: null });
  const [zip, setZip] = useState({ running: false, done: 0, total: 0, bytes: 0, note: null, error: null });

  // Mirrors for the 1s poll's change check — refs so the callback never has to be
  // recreated (same pattern as PinBoardTool).
  const recordsRef = useRef([]);
  const stateRef = useRef(state);

  const send = useCallback(async (msg) => {
    if (tabId.current == null) tabId.current = await resolvePlatformTab("facebook");
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
    const res = await send({ type: "FBW_FBPHOTOS_CONTEXT" });
    if (res) setCtx(res);
  }, [send]);

  useEffect(() => {
    loadContext();
    // Slow cadence: context is only used to tell the user whether they are on the
    // right tab, and SPA navigation between profiles is a human-speed event.
    return startPolling(loadContext, 5000);
  }, [loadContext]);

  const pullState = useCallback(async () => {
    const res = await send({ type: "FBW_FBPHOTOS_STATE" });
    if (!res) return;
    const next = res.records || [];
    const ns = {
      scraping: !!res.scraping,
      phase: res.phase || "idle",
      scrolls: res.scrolls || 0,
      hitCap: !!res.hitCap,
      capReason: res.capReason || null,
      error: res.error || null,
      owner: res.owner || null,
      caps: res.caps || null,
    };
    const prev = stateRef.current;
    // A profile can hold hundreds of tiles; re-rendering the whole grid every
    // second when nothing moved is pure waste. `resolved` is in the signature
    // because full URLs land as the capture relays them, while the count sits still.
    const sameLen = recordsRef.current.length === next.length;
    const sameResolved = summarize(recordsRef.current).resolved === summarize(next).resolved;
    if (
      sameLen && sameResolved &&
      prev.scraping === ns.scraping && prev.phase === ns.phase && prev.scrolls === ns.scrolls &&
      prev.hitCap === ns.hitCap && prev.capReason === ns.capReason &&
      prev.error === ns.error && prev.owner === ns.owner
    )
      return;
    recordsRef.current = next;
    stateRef.current = ns;
    setRecords(next);
    setState(ns);
  }, [send]);

  useEffect(() => {
    pullState();
    return startPolling(pullState, 1000);
  }, [pullState]);

  const scrape = useCallback(async () => {
    setZip({ running: false, done: 0, total: 0, bytes: 0, note: null, error: null });
    await send({ type: "FBW_FBPHOTOS_SCRAPE" });
    pullState();
  }, [send, pullState]);

  const stop = useCallback(async () => {
    await send({ type: "FBW_FBPHOTOS_STOP" });
    pullState();
  }, [send, pullState]);

  const clear = useCallback(async () => {
    await send({ type: "FBW_FBPHOTOS_CLEAR" });
    recordsRef.current = [];
    setRecords([]);
    setZip({ running: false, done: 0, total: 0, bytes: 0, note: null, error: null });
    pullState();
  }, [send, pullState]);

  const stats = summarize(records);
  const owner = state.owner || ctx?.owner || ctx?.ownerKey || null;

  async function downloadZip() {
    const { batch, skipped, unresolved } = selectForZip(records, { maxCount: MAX_ZIP_PHOTOS });
    if (!batch.length) return;

    const builder = new ZipBuilder({ date: new Date() });
    const openingNote = zipNotes({ skipped, unresolved, maxCount: MAX_ZIP_PHOTOS });
    setZip({ running: true, done: 0, total: batch.length, bytes: 0, note: openingNote, error: null });

    let bytes = 0;
    let failed = 0;
    let stoppedAt = null;
    try {
      for (let i = 0; i < batch.length; i++) {
        const rec = batch[i];
        // Byte budget beats the count cap: a handful of very large photos can blow
        // past the memory a side panel should hold long before 150 files do.
        if (bytes >= MAX_ZIP_BYTES) { stoppedAt = i; break; }
        try {
          // `rec.url` is always the uncropped viewer_image — selectForZip never
          // falls back to the tile's crop.
          const res = await fetch(rec.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = new Uint8Array(await res.arrayBuffer());
          builder.add(filenameFor({ ...rec, owner }, extFromUrl(rec.url, "image")), data);
          bytes += data.length;
        } catch {
          failed++;
        }
        setZip((z) => ({ ...z, done: i + 1, bytes }));
        if (i < batch.length - 1) await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
      }

      if (!builder.count) throw new Error("nenhuma foto pôde ser baixada");
      // The photos this run could NOT resolve go into the archive as a text list,
      // so the gap travels with the download instead of only living in a panel
      // line the user will have closed by tomorrow.
      const manifest = unresolvedManifest(records, owner);
      if (manifest) builder.add(UNRESOLVED_ENTRY, TEXT.encode(manifest));
      // finish() returns the parts array; handing it straight to Blob lets Chrome
      // spill the archive to disk instead of materialising one giant ArrayBuffer.
      const blob = new Blob(builder.finish(), { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const id = await chrome.downloads.download({ url, filename: zipFilename(owner, new Date()) });
      // The object URL has to outlive the download's read of it, so revoke on the
      // download's own completion, with a timeout as the backstop for a panel that
      // gets closed (or a listener that never fires).
      const onChanged = (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === "complete" || delta.state.current === "interrupted") {
          URL.revokeObjectURL(url);
          chrome.downloads.onChanged.removeListener(onChanged);
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
      setTimeout(() => { try { URL.revokeObjectURL(url); chrome.downloads.onChanged.removeListener(onChanged); } catch { /* already gone */ } }, 5 * 60 * 1000);

      setZip((z) => ({
        ...z,
        running: false,
        bytes,
        note: zipNotes({ skipped, unresolved, stoppedAt, failed, maxCount: MAX_ZIP_PHOTOS, maxBytes: MAX_ZIP_BYTES }),
      }));
    } catch (e) {
      setZip((z) => ({ ...z, running: false, error: e.message || String(e) }));
    }
  }

  if (noTab)
    return (
      <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
        Abra o Facebook em uma aba (com login feito) e reabra este painel.
      </div>
    );

  if (!ctx) return <p className="py-8 text-center text-sm text-muted-foreground">Lendo a página…</p>;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="text-[13px] font-medium">{owner || "Perfil do Facebook"}</div>
        <div className="text-[11px] text-muted-foreground">
          {ctx.onPhotos
            ? `aba Fotos · ${ctx.tiles} miniatura(s) na tela`
            : "abra a aba Fotos do perfil (Fotos → Todas as fotos) para coletar"}
        </div>
      </div>

      {/* One row, two controls. There is no collection mode any more: the full
          image rides along with the grid, so "fast" and "high resolution" are the
          same run. */}
      <ToolBar>
        <ActionButton
          className="basis-0 grow"
          icon={state.scraping ? Square : Play}
          label={state.scraping ? "Parar" : "Coletar"}
          hint={
            state.scraping
              ? "Parar a coleta em andamento"
              : "Rolar a grade e guardar a foto inteira de cada miniatura — sem abrir foto nenhuma, sem sair da aba"
          }
          onClick={state.scraping ? stop : scrape}
          disabled={zip.running}
        />
        <ActionButton
          className="basis-0 grow"
          icon={RotateCw}
          label="Limpar"
          hint="Esquecer as fotos coletadas"
          variant="outline"
          onClick={clear}
          disabled={zip.running}
        />
      </ToolBar>

      {/* The one thing that can still go wrong, stated BEFORE the download
          button: a photo whose GraphQL row was never captured has no full image,
          and the tool will not hand over its square crop instead. */}
      {stats.pending ? (
        <div className="rounded-md bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700">
          {stats.pending} de {stats.total} foto(s) sem a imagem inteira — ficam de fora do ZIP (e listadas nele em{" "}
          {UNRESOLVED_ENTRY}). Colete de novo para tentar resolvê-las.
        </div>
      ) : null}

      <ToolBar>
        {/* `basis-0 grow` (never `flex-1`) is how ActionButton is made to fill a
            row — see the note in ToolBar.jsx about the tailwind-merge collision
            between flex-1 and the button's own shrink-0. */}
        <ActionButton
          className="basis-0 grow"
          icon={FileArchive}
          label={zip.running ? `Compactando… ${zip.done}/${zip.total}` : `Baixar tudo (ZIP) · ${stats.resolved}`}
          hint={`Baixar ${stats.resolved} foto(s) inteiras (sem recorte) em um único arquivo ZIP`}
          variant="secondary"
          onClick={downloadZip}
          disabled={zip.running || state.scraping || !stats.resolved}
        />
      </ToolBar>

      <div className="text-[11px] text-muted-foreground">
        {stats.total} foto(s) · {stats.resolved} inteira(s)
        {state.scraping
          ? state.phase === "resolving"
            ? " · resolvendo o que faltou"
            : ` · rolando a grade (${state.scrolls})`
          : state.phase === "done"
            ? " · concluído"
            : ""}
        {state.hitCap && state.caps ? ` · ${capMessage(state.capReason, state.caps)}` : ""}
      </div>

      {state.error ? (
        <div className="rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-700">{state.error}</div>
      ) : null}
      {zip.error ? (
        <div className="rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-700">ZIP: {zip.error}</div>
      ) : null}
      {zip.note ? (
        <div className="rounded-md bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700">{zip.note}</div>
      ) : null}
      {zip.running || zip.bytes ? (
        <div className="text-[11px] text-muted-foreground">
          ZIP: {zip.done}/{zip.total} · {fmtBytes(zip.bytes)}
        </div>
      ) : null}

      {/* Per-photo state: the badge is the photo's real size once the full image
          is in hand, and an explicit "sem original" when it is not — the two
          cases must never look alike. */}
      <div className="grid grid-cols-3 gap-1.5">
        {records.map((rec) => (
          <a
            key={rec.fbid}
            href={rec.permalink || photoPermalink(rec.fbid, rec.set)}
            target="_blank"
            rel="noreferrer"
            className="group relative block aspect-square overflow-hidden rounded-lg bg-muted ring-1 ring-black/5"
            title={tileTitle(rec)}
          >
            {rec.thumb ? (
              <img src={rec.thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
            ) : null}
            {rec.full ? (
              <span className="absolute right-1 top-1 rounded bg-emerald-500/85 px-1 text-[9px] font-semibold text-white">
                {rec.width && rec.height ? `${rec.width}×${rec.height}` : "inteira"}
              </span>
            ) : (
              <span className="absolute right-1 top-1 rounded bg-amber-500/90 px-1 text-[9px] font-semibold text-white">
                sem original
              </span>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}
