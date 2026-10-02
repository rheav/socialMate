import { useCallback, useEffect, useState } from "react";
import {
  Bookmark,
  ArrowUp,
  ArrowDown,
  Eye,
  MessageCircle,
  Share2,
  ImageDown,
  Loader2,
  RefreshCw,
  Download, FileText, AudioLines, Link, Heart, Square, EyeOff,
} from "lucide-react";
import { ToolBar, ActionButton, ToolIconButton, ToolSelect } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import { useContentLink } from "@/lib/useContentLink";
import { requireOk } from "@/lib/bg";
import { fbReelEntry } from "@/lib/shared/fbReelActions";
import { FB_QUERY_FIELDS, fbEngagement } from "@/lib/shared/fbQuery";
import { applyQuery, primarySort, withPrimarySort, isSortableField } from "@/lib/shared/feedQuery";
import { fmtER, fmtDate, fmtVelocity, viewsPerDay } from "@/lib/shared/fmt";
import useFeedQuery from "@/lib/useFeedQuery";
import useStoredFlag from "@/lib/useStoredFlag";
import QueryBuilder from "@/components/ui/QueryBuilder";
import { readStoredTranscriptLanguage } from "@/lib/transcriptionLanguage";
import { recordToCard, filenameFor, fmtCount, fullResThumb } from "@/lib/fbReels";
import { startPolling } from "@/lib/poll";
import { useItemStatus, statusKey, statusTitle } from "@/lib/useItemStatus";
import useStagger from "@/lib/useStagger";
import IconBtn from "@/components/ui/IconBtn";

// `short` is the word the sort trigger falls back to once the row is too narrow
// for the full label — a whole word, never an ellipsis. Values are unchanged.
const SORT_OPTS = [{value:'default',label:'Padrão'}, ...Object.entries(FB_QUERY_FIELDS).filter(([,f])=>isSortableField(f)).map(([value,f])=>({value,label:f.label,short:f.short}))];

// Facebook Reels Sort — reads the reels-tab grid (DOM tiles + initial embedded
// JSON, via the FB reels-capture content script), sorts it in-panel as a 2-col
// grid of 9:16 cards with a right-side stat rail (views / comments / shares),
// and downloads thumbnails or saves reels to the shared Library.
export default function FbReelsTool() {
  const [records, setRecords] = useState([]);
  const [owner, setOwner] = useState(null);
  const [onReelsTab, setOnReelsTab] = useState(true);
  const [query,setQuery]=useFeedQuery('sw_fb_query',FB_QUERY_FIELDS);
  const {key:sortKey,dir:sortDir}=primarySort(query);
  const setSortKey=k=>setQuery(q=>withPrimarySort(q,k,primarySort(q).dir));
  const [overlay,setOverlay]=useStoredFlag('sw_fb_overlay');
  const [actionError,setActionError]=useState(null);
  const [jobStates,setJobStates]=useState({});
  const [voiceStates,setVoiceStates]=useState({});
  const [harvesting, setHarvesting] = useState(false);
  const { link, noTab, fixing, send, revive, openTab } = useContentLink("facebook");

  // Saved-ids mirror (yellow-filled bookmark), live via storage.onChanged.
  const [savedIds, setSavedIds] = useState({});
  useEffect(() => {
    if (!chrome?.storage?.local) return;
    const load = () =>
      chrome.storage.local.get("fbw_saved", (r) => {
        const s = {};
        for (const k in r.fbw_saved || {}) s[k] = true;
        setSavedIds(s);
      });
    load();
    const onCh = (c, area) => { if (area === "local" && c.fbw_saved) load(); };
    chrome.storage.onChanged.addListener(onCh);
    return () => chrome.storage.onChanged.removeListener(onCh);
  }, []);

  const apply = useCallback((res) => {
    if (!res || !Array.isArray(res.records)) return;
    setRecords(res.records);
    setOwner(res.owner || null);
    setOnReelsTab(!!res.onReelsTab);
    setHarvesting(!!res.harvesting);
    setJobStates(res.jobs || {});
    setVoiceStates(res.voices || {});
  }, []);

  const listFromTab = useCallback(async () => {
    apply(await send({ type: "FBW_FB_REELS_LIST" }));
  }, [send, apply]);

  useEffect(() => {
    return startPolling(listFromTab, 3000); // skips ticks while the panel is hidden
  }, [listFromTab]);

  // Auto-scroll the FB grid to load every reel, then take the full list.
  async function collectAll() {
    setHarvesting(true);
    try {
      // userAction: a click that can't reach the page says so at once.
      apply(
        await send(
          { type: "FBW_FB_REELS_HARVEST" },
          { userAction: true, action: "coletar os reels" },
        ),
      );
    } finally {
      setHarvesting(false);
    }
  }

  const sorted = applyQuery(records, query, FB_QUERY_FIELDS);
  const stagger = useStagger(`${sortKey}|${sortDir}`);

  // Per-action status. The thumbnail is the only action routed through this hook
  // (the card's save button reports through the savedIds mirror instead), so the
  // record's primary key is enough — and a failure now keeps its reason for the
  // button's tooltip instead of only painting the icon red.
  const { run, statusOf, errorOf } = useItemStatus();

  async function downloadThumb(rec) {
    if (!rec.thumb) return;
    // The card renders the grid's own 540x960 crop (cheap for a 2-col panel), but
    // what gets SAVED is the native 1080x1920 frame — see lib/shared/fbReelThumb.js.
    await run(statusKey(rec.id), () =>
      requireOk({
        type: "FBW_DL_MEDIA",
        kind: "image",
        url: fullResThumb(rec.thumb),
        filename: filenameFor(owner, rec.id),
      }),
    );
  }

  async function downloadAllThumbs() {
    for (const rec of sorted) {
      await downloadThumb(rec);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Toggle: first tap saves the reel to the shared Library, second removes.
  // The background owns the write (serialized, so the panel and a page overlay
  // can't clobber each other) and replies with the state AFTER the toggle.
  async function saveToLibrary(rec) {
    // Counts go in RAW — fmtCount is render-time only (see the stat rail below).
    const entry = fbReelEntry({...rec,authorName:rec.authorName||owner});
    if (!entry) return;
    try {
      const { saved } = await requireOk({ type: "FBW_SAVED_TOGGLE", entry });
      // Trust the reply over guessing; the storage.onChanged mirror above also
      // re-syncs, so this only removes the one-tick lag.
      setSavedIds((s) => {
        const next = { ...s };
        if (saved) next[rec.id] = true;
        else delete next[rec.id];
        return next;
      });
    } catch (e) {
      setActionError(e.message);
    }
  }

  async function reelAction(rec, action) {
    setActionError(null);
    if(action==='copy') { try { await navigator.clipboard.writeText(`https://www.facebook.com/reel/${rec.id}`); } catch(e) { setActionError(e.message); } return; }
    await run(statusKey(rec.id,action),async()=>{
      const res=await send({type:'FBW_FB_REEL_ACTION',id:rec.id,action,language:await readStoredTranscriptLanguage()}, {userAction:true,action:action==='transcribe'?'transcrever o reel':'processar o reel'});
      if(!res?.ok){const message=res?.error||'Não foi possível concluir a ação';setActionError(message);throw new Error(message);}
    });
  }

  // One banner for every link failure, rendered in every branch below so the
  // explanation (and its fix) can never be hidden by an empty state.
  const banner = (
    <ContentLinkBanner
      link={link}
      platformName="Facebook"
      fixing={fixing}
      onRevive={revive}
      onOpenTab={openTab}
    />
  );

  if (noTab) return banner;

  return (
    <div className="space-y-3">
      {banner}
      <ToolBar>
        <ToolSelect label="Ordenar por" value={sortKey} onValueChange={setSortKey} options={SORT_OPTS} />
        <ToolIconButton
          icon={sortDir === "desc" ? ArrowDown : ArrowUp}
          label={sortDir === "desc" ? "Maior → menor" : "Menor → maior"}
          onClick={() => setQuery(q => sortKey === "default" ? q : withPrimarySort(q,sortKey,sortDir === "desc" ? "asc" : "desc"))}
        />
        <ActionButton
          icon={harvesting ? Loader2 : RefreshCw}
          iconClassName={harvesting ? "animate-spin" : undefined}
          label={harvesting ? "Coletando" : "Coletar tudo"}
          hint="Rolar a grade para carregar todos os reels"
          variant="secondary"
          onClick={collectAll}
          disabled={harvesting}
        />
        {harvesting && <ToolIconButton icon={Square} label="Parar coleta" onClick={()=>send({type:'FBW_FB_REELS_STOP'})} />}
        <ToolIconButton icon={overlay?Eye:EyeOff} label={overlay?'Ocultar dados na página':'Mostrar dados na página'} onClick={()=>setOverlay(!overlay)} />
      </ToolBar>
      <QueryBuilder query={query} setQuery={setQuery} fields={FB_QUERY_FIELDS} primaryKey={sortKey} />
      {actionError && <p role="alert" className="text-xs text-danger">{actionError}</p>}
      <p className="text-[10px] text-muted-foreground">Views, compartilhamentos e taxas podem usar contagens abreviadas. TE = (curtidas + 4×comentários + 4×compartilhamentos) / views.</p>

      {/* flex-wrap, not truncate: the action drops to its own line instead of
          the owner name losing characters. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 break-words">
          {sorted.length} reels{owner ? ` · ${owner}` : ""}
        </span>
        <button
          className="shrink-0 underline disabled:opacity-50"
          onClick={downloadAllThumbs}
          disabled={!sorted.length}
        >
          baixar todas as miniaturas
        </button>
      </div>

      {!onReelsTab && (
        <div className="rounded-md bg-amber/10 text-amber text-[11px] px-3 py-2">
          Abra a aba <span className="font-semibold">Reels</span> do perfil no Facebook e toque em Coletar tudo.
        </div>
      )}

      {!sorted.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Abra a aba Reels de um perfil e toque em <span className="font-medium text-foreground">Coletar tudo</span> para carregar e ordenar os reels aqui.
        </p>
      ) : (
        <div className={"grid grid-cols-2 gap-2 " + stagger}>
          {sorted.map((rec) => {
            const c = recordToCard(rec);
            const st = statusOf(statusKey(c.id));
            return (
              <div
                key={c.id}
                className="group relative aspect-[9/16] overflow-hidden rounded-xl bg-muted ring-1 ring-black/5"
              >
                {c.thumb ? (
                  <a href={c.permalink} target="_blank" rel="noreferrer" className="absolute inset-0">
                    <img src={c.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  </a>
                ) : null}

                {/* actions — top-left */}
                <div className="absolute left-1.5 top-1.5 flex flex-col gap-1">
                  <IconBtn
                    title={savedIds[c.id] ? "Salvo — toque para remover" : "Salvar na biblioteca"}
                    onClick={() => saveToLibrary(rec)}
                  >
                    <Bookmark className={"size-3.5 " + (savedIds[c.id] ? "fill-amber text-amber" : "")} />
                  </IconBtn>
                  {[[Download,'download','Baixar vídeo'],[FileText,'transcribe','Transcrever vídeo'],[AudioLines,'voice','Extrair voz / cancelar'],[Link,'copy','Copiar link']].map(([Icon,action,title])=>{
                    const st=statusOf(statusKey(c.id,action));
                    const job=jobStates[`${c.id}:${action}`];
                    const voice=action==='voice'?voiceStates[c.id]:null;
                    const voiceRunning=voice&&!['done','error','cancelled'].includes(voice.phase);
                    const voiceTitle=voiceRunning?`Extraindo voz (${Math.round(voice.pct||0)}%) — cancelar`:voice?.error||(voice?.phase==='done'?'Voz enviada aos downloads':null);
                    return <IconBtn key={action} title={voiceTitle || job?.error || (job?.busy?'Processando — acompanhe na biblioteca':statusTitle(title,st,errorOf(statusKey(c.id,action))))} disabled={st==='downloading'||job?.busy} onClick={()=>reelAction(rec,action)}>{voiceRunning?<span className="text-[9px]">{Math.round(voice.pct||0)}%</span>:<Icon className="size-3.5" />}</IconBtn>;
                  })}
                  <IconBtn
                    title={statusTitle("Baixar miniatura", st, errorOf(statusKey(c.id)))}
                    onClick={() => downloadThumb(rec)}
                    disabled={st === "downloading"}
                  >
                    {st === "downloading" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ImageDown className={"size-3.5 " + (st === "done" ? "text-good" : st === "error" ? "text-danger" : "")} />
                    )}
                  </IconBtn>
                </div>

                {/* stat rail — right side, subtle blue glow */}
                <div className="absolute bottom-9 right-1.5 flex flex-col items-end gap-0.5 rounded-lg border border-sky/30 bg-black/60 px-2 py-1.5 text-white shadow-[0_0_10px_rgba(56,130,246,0.28)]">
                  <div className="flex items-center gap-1 text-[14px] font-extrabold leading-none">
                    <Eye className="size-3.5" />
                    {c.views != null ? fmtCount(c.views) : "—"}
                  </div>
                  {rec.likes != null && <div className="flex items-center gap-1 text-[11.5px] font-bold"><Heart className="size-3" />{fmtCount(rec.likes)}</div>}
                  {c.comments != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <MessageCircle className="size-3" />
                      {fmtCount(c.comments)}
                    </div>
                  )}
                  {c.shares != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <Share2 className="size-3" />
                      {fmtCount(c.shares)}
                    </div>
                  )}
                </div>

                <div className="pointer-events-none absolute bottom-9 left-1.5 rounded bg-black/70 px-1 text-[9px] text-white">
                  {fmtER(fbEngagement(rec)) && <div title="Taxa de engajamento ponderada">{fmtER(fbEngagement(rec))}</div>}
                  {rec.taken_at && <><div>{fmtVelocity(viewsPerDay(rec.views,rec.taken_at))}</div><div>{fmtDate(rec.taken_at)}</div></>}
                  {rec.duration && <div>{Math.round(rec.duration)} s</div>}
                </div>
                {/* open-on-facebook — bottom gradient */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6">
                  <a
                    href={c.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="pointer-events-auto block max-w-[70%] truncate text-[12px] font-semibold text-white"
                  >
                    Abrir reel
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
