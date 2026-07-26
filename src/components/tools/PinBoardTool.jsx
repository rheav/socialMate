import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RotateCw, Play, Image as ImageIcon, Film, Layers, Bookmark } from "lucide-react";
import { ToolBar, ActionButton, ToolSelect } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import { useContentLink } from "@/lib/useContentLink";
import { startPolling } from "@/lib/poll";
import { useItemStatus, statusKey, statusTitle } from "@/lib/useItemStatus";
import { requireOk } from "@/lib/bg";
import { buildSavedEntry } from "@/lib/shared/savedEntry";
import { sortRecords, recordToCard, fmtCount, filenameFor, extFromUrl } from "@/lib/pinMedia";
import IconBtn from "@/components/ui/IconBtn";

const MAX_PAGES = 40; // ~1000 pins per run — surfaced in the UI, never a silent cap.
// `short` is what the trigger shows once the row is too narrow for the full
// wording — a whole word, not an ellipsis. Values are unchanged (persisted
// nowhere, but they drive sortRecords).
const SORT_OPTS = [
  { value: "default", label: "Ordem da pasta", short: "Pasta" },
  { value: "saves", label: "Mais salvos", short: "Salvos" },
  { value: "comments", label: "Mais comentados", short: "Coment." },
  { value: "date", label: "Mais recentes", short: "Recentes" },
];

// Pinterest Board tool. Unlike the IG/TT tools this is not polling a passive
// capture — pin-api.js actively pages Pinterest's resource API, so the panel asks
// for context once per surface and then drives an explicit Harvest.
export default function PinBoardTool() {
  const [ctx, setCtx] = useState(null);
  const { link, noTab, fixing, send, revive, openTab } = useContentLink("pinterest");

  const [records, setRecords] = useState([]);
  const [state, setState] = useState({ harvesting: false, pages: 0, done: false, hitCap: false, error: null });
  const [sortKey, setSortKey] = useState("default");

  // Mirrors of `records`/`state` for pullState's change check below — a ref (not the
  // state itself) so the 1s poll can compare without becoming a dependency that
  // recreates the callback every render.
  const recordsRef = useRef([]);
  const stateRef = useRef({ harvesting: false, pages: 0, done: false, hitCap: false, error: null });
  const applyRecords = useCallback((next) => { recordsRef.current = next; setRecords(next); }, []);

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

  const pullState = useCallback(async () => {
    const res = await send({ type: "FBW_PIN_STATE" });
    if (!res) return;
    const nextRecords = res.records || [];
    const nextState = { harvesting: !!res.harvesting, pages: res.pages || 0, done: !!res.done, hitCap: !!res.hitCap, error: res.error || null };
    const prev = stateRef.current;
    // The grid can hold 870+ tiles on a real board; re-rendering all of them once a
    // second forever (this poll never stops while the panel is open) is wasted work
    // whenever nothing actually changed. Compare against the last-applied snapshot
    // and skip both setStates when the diff is empty — harvesting still updates the
    // UI every tick because pages/records.length are moving.
    if (
      recordsRef.current.length === nextRecords.length &&
      prev.harvesting === nextState.harvesting &&
      prev.pages === nextState.pages &&
      prev.done === nextState.done &&
      prev.hitCap === nextState.hitCap &&
      prev.error === nextState.error
    )
      return;
    recordsRef.current = nextRecords;
    stateRef.current = nextState;
    setRecords(nextRecords);
    setState(nextState);
  }, [send]);

  useEffect(() => {
    // Harvest is a live, possibly long-running job — poll every second, but
    // via startPolling so a hidden panel doesn't keep waking the content script.
    return startPolling(pullState, 1000);
  }, [pullState]);

  // userAction on both: these are clicks, so an unreachable page is reported at
  // once instead of leaving the button looking inert.
  const harvest = useCallback(async () => {
    applyRecords([]);
    await send(
      { type: "FBW_PIN_HARVEST", maxPages: MAX_PAGES },
      { userAction: true, action: "coletar os pins" },
    );
    pullState();
  }, [send, pullState, applyRecords]);

  const clear = useCallback(async () => {
    await send(
      { type: "FBW_PIN_CLEAR" },
      { userAction: true, action: "limpar os pins" },
    );
    applyRecords([]);
    pullState();
  }, [send, pullState, applyRecords]);

  const sorted = sortRecords(records, sortKey, "desc");

  // Per-action status, shared hook: it keeps the failure REASON so the download
  // arrow's tooltip can say why instead of just turning red.
  const { run, statusOf, errorOf } = useItemStatus();

  // Mirror fbw_saved so the bookmark reflects reality — without this the icon never
  // fills, so a toggle action looks like a no-op and a second tap silently removes
  // the item. The background is the only writer; this is a read-only mirror.
  const [savedIds, setSavedIds] = useState({});
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    const load = () =>
      chrome.storage.local.get("fbw_saved", (r) => {
        const s = {};
        for (const k in r.fbw_saved || {}) s[k] = true;
        setSavedIds(s);
      });
    load();
    const onCh = (c, area) => {
      if (area === "local" && c.fbw_saved) load();
    };
    chrome.storage.onChanged.addListener(onCh);
    return () => chrome.storage.onChanged.removeListener(onCh);
  }, []);

  async function downloadRecord(rec) {
    // One status for the whole pin — an idea pin is several requests, one arrow.
    await run(statusKey(rec.id), async () => {
      const multi = rec.items.length > 1;
      for (let i = 0; i < rec.items.length; i++) {
        const item = rec.items[i];
        let url = item.url;
        // ~80% of Pinterest videos are HLS-only. The content script derives a real
        // MP4 from the master manifest; a plain .m3u8 would download as a useless
        // text playlist.
        if (item.kind === "video" && item.hls) {
          const r = await send({ type: "FBW_PIN_RESOLVE", id: rec.id, itemIndex: i });
          if (!r?.ok) throw new Error(r?.error || "não foi possível resolver o vídeo");
          url = r.url;
        }
        const ext = extFromUrl(url, item.kind);
        await requireOk({
          type: "FBW_DL_MEDIA",
          kind: item.kind,
          url,
          filename: filenameFor(rec, ext, multi ? i + 1 : null),
        });
      }
    });
  }

  async function save(rec) {
    // Own status key — a failed save must not touch the download arrow's state,
    // and its reason belongs on the bookmark's own tooltip.
    await run(statusKey(rec.id, "save"), async () => {
      // The background owns the write and decides insert-vs-remove by whether the
      // id is already in `fbw_saved`, so this is a single toggle message — no
      // read-modify-write here (that raced the page overlay) and no remove branch.
      const entry = buildSavedEntry({
        id: rec.id,
        platform: "pinterest",
        thumb: rec.thumb,
        caption: rec.title || rec.description,
        // rec.username, NOT fullName — pin-api.js's page-side save passes the
        // username and documents that the two shapes match exactly.
        authorName: rec.username,
        username: rec.username,
        // Raw numbers: formatting is a render-time concern in TranscriptsPanel.
        counts: { like: rec.saves, comment: rec.comments },
        code: rec.id,
        // TranscriptsPanel only knows how to rebuild FB/IG permalinks, so Pinterest
        // must always carry its own.
        sourceUrl: rec.permalink,
      });
      await requireOk({ type: "FBW_SAVED_TOGGLE", entry });
    });
  }

  // Serial with a 400 ms gap, matching IgSortTool/TtSortTool. Chrome will happily
  // accept parallel downloads, but Pinterest's CDN starts refusing under a burst.
  async function downloadAll() {
    for (const rec of sorted) {
      await downloadRecord(rec);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // One banner for every link failure, rendered in every branch below so the
  // explanation (and its fix) can never be hidden by an empty state — this is
  // the panel that used to sit on "Lendo a página…" forever when pin-api.js was
  // not live in the tab (see the note in lib/tabs.js).
  const banner = (
    <ContentLinkBanner
      link={link}
      platformName="Pinterest"
      fixing={fixing}
      onRevive={revive}
      onOpenTab={openTab}
    />
  );

  if (noTab) return banner;

  if (!ctx)
    return (
      <div className="space-y-2">
        {banner}
        <p className="py-8 text-center text-sm text-muted-foreground">Lendo a página…</p>
      </div>
    );

  return (
    <div className="space-y-2">
      {banner}
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="text-[13px] font-medium">{ctx.board?.name || ctx.surface?.kind}</div>
        <div className="text-[11px] text-muted-foreground">
          superfície: {ctx.surface?.kind} · pasta: {ctx.board?.id || "—"} · pins: {ctx.board?.pin_count ?? "—"} · subpastas: {ctx.sections?.length ?? 0}
        </div>
        {ctx.error ? <div className="mt-1 text-[11px] text-red-600">{ctx.error}</div> : null}
      </div>

      {/* `dense`: three labelled buttons AND a select. At the ordinary threshold
          the labels would switch on at a 338px panel and starve the sorter down
          to ~33px — see ToolBar.jsx for the measured numbers. */}
      <ToolBar dense>
        <ActionButton
          icon={Play}
          label={state.harvesting ? `Coletando… ${state.pages}p` : "Coletar"}
          hint="Coletar os pins desta pasta"
          onClick={harvest}
          disabled={state.harvesting}
        />
        <ActionButton
          icon={RotateCw}
          label="Limpar"
          hint="Limpar os pins coletados"
          variant="outline"
          onClick={clear}
          disabled={state.harvesting}
        />
        <ActionButton
          icon={Download}
          label={`Tudo (${records.length})`}
          hint={`Baixar todos os ${records.length} pin(s)`}
          variant="secondary"
          onClick={downloadAll}
          disabled={!records.length || state.harvesting}
        />
        {/* max-w keeps the sorter from eating a wide panel; ml-auto then parks
            it on the right the way the old natural-width <select> did. */}
        <ToolSelect
          label="Ordenar"
          value={sortKey}
          onValueChange={setSortKey}
          options={SORT_OPTS}
          className="ml-auto max-w-[170px]"
        />
      </ToolBar>

      <div className="text-[11px] text-muted-foreground">
        {records.length} pin(s) · {state.pages} página(s)
        {/* done and hitCap are mutually exclusive (set from pin-api.js's reachedEnd branch),
            so "complete" and the cap message never render together. */}
        {state.harvesting ? " · em andamento" : state.done ? " · concluído" : ""}
        {state.hitCap ? ` · parado no limite de ${MAX_PAGES} páginas — colete novamente para mais` : ""}
      </div>
      {state.error ? <div className="rounded-md bg-red-500/10 px-3 py-2 text-[11px] text-red-700">{state.error}</div> : null}

      <div className="grid grid-cols-3 gap-1.5">
        {sorted.map((rec) => {
          const card = recordToCard(rec);
          const st = statusOf(statusKey(rec.id));
          const stSave = statusOf(statusKey(rec.id, "save"));
          const Badge = card.mediaType === "video" ? Film : card.mediaType === "idea" ? Layers : ImageIcon;
          return (
            <div key={card.id} className="group relative aspect-[3/4] overflow-hidden rounded-lg bg-muted ring-1 ring-black/5">
              <IconBtn
                onClick={() => downloadRecord(rec)}
                disabled={st === "downloading"}
                className="absolute left-1 top-1 z-10"
                title={statusTitle(
                  rec.items.length > 1 ? `Baixar ${rec.items.length} arquivos` : "Baixar",
                  st,
                  errorOf(statusKey(rec.id)),
                )}
              >
                <Download className={"size-3.5 " + (st === "done" ? "text-emerald-400" : st === "error" ? "text-red-400" : "")} />
              </IconBtn>
              <IconBtn
                onClick={() => save(rec)}
                disabled={stSave === "downloading"}
                className="absolute left-1 top-8 z-10"
                title={statusTitle(
                  savedIds[rec.id] ? "Salvo — toque para remover" : "Salvar na biblioteca",
                  stSave,
                  errorOf(statusKey(rec.id, "save")),
                )}
              >
                <Bookmark
                  className={
                    "size-3.5 " +
                    (stSave === "error"
                      ? "text-red-400"
                      : savedIds[rec.id]
                        ? "fill-current text-amber-300"
                        : "")
                  }
                />
              </IconBtn>
              {card.thumb ? (
                <img src={card.thumb} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
              ) : null}
              <span className="absolute right-1 top-1 grid size-5 place-items-center rounded bg-black/65 text-white">
                <Badge className="size-3" />
              </span>
              {card.saves != null && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-[9.5px] font-semibold text-white">
                  {fmtCount(card.saves)} salvamentos
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
