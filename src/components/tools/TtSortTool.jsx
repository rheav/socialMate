import { useCallback, useEffect, useState, useRef } from "react";
import {
  Download,
  Bookmark,
  ArrowUp,
  ArrowDown,
  Heart,
  MessageCircle,
  Eye,
  Zap,
  Share2,
  Calendar,
  Play,
  ImageDown,
  FileText,
  Loader2,
  Copy,
  Check,
  X,
  Pin,
  RotateCw,
  Trash2,
  ChevronsDown,
  ChevronDown,
  Square,
  Sheet,
  Users,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ToolBar, ActionButton, ToolIconButton, ToolSelect } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import { useContentLink } from "@/lib/useContentLink";
import { requireOk } from "@/lib/bg";
import { buildSavedEntry } from "@/lib/shared/savedEntry";
import { startPolling } from "@/lib/poll";
import { useItemStatus, statusKey, statusTitle } from "@/lib/useItemStatus";
import useStagger from "@/lib/useStagger";
import { readStoredTranscriptLanguage } from "@/lib/transcriptionLanguage.js";
import IconBtn from "@/components/ui/IconBtn";
import MetricLegend from "@/components/ui/MetricLegend";
import {
  sortRecords,
  recordToCard,
  filenameFor,
  thumbFilenameFor,
  extFromUrl,
  fmtCount,
  filterBySurface,
  engagementRate,
  fmtER,
  fmtRatio,
  ttPermalink,
  TT_ER_WEIGHTS,
  TT_ER_WEIGHTS_KEY,
  normalizeTtErWeights,
  ttViewsPerFollower,
} from "@/lib/ttMedia";
import { reachTier } from "@/lib/shared/ttFormat.js";
// Not "igFilters": the date window and the scroll cadence are platform-neutral —
// TikTok's createTime is the same unix-seconds stamp Instagram's taken_at is.
import { DATE_RANGES, withinDateRange } from "@/lib/shared/harvest.js";
import { buildXlsx } from "@/lib/xlsx";
import { downloadPath } from "@/lib/downloadPath";

// `short` is the word the sort trigger falls back to once the row is too narrow
// for the full label — a whole word, never an ellipsis. Values are unchanged.
const SORT_OPTS = [
  { value: "default", label: "Padrão" },
  // Second, and named the way the CARD names it. This sorted by views-per-
  // follower all along, but under the label "Views por seguidor" — while the
  // card printed "352×" beside a trending-up glyph and called it Alcance. Same
  // number, two names, so the option nobody could find was the headline metric.
  { value: "vpf", label: "Alcance (×)", short: "Alcance" },
  { value: "views", label: "Visualizações", short: "Visualiz." },
  { value: "likes", label: "Curtidas" },
  { value: "comments", label: "Comentários", short: "Coment." },
  { value: "shares", label: "Compartilhamentos", short: "Compart." },
  { value: "saves", label: "Salvamentos", short: "Salvos" },
  { value: "er", label: "TE %" },
  { value: "followers", label: "Seguidores", short: "Segs." },
  { value: "date", label: "Data" },
];

// TikTok hands the follower count over on every list item (authorStats), so these
// two columns cost nothing extra — on Instagram the same numbers need a separate
// enrichment request per post.
const XLSX_COLS = [
  { key: "id", label: "ID" },
  { key: "url", label: "Link" },
  { key: "username", label: "Perfil" },
  { key: "followers", label: "Seguidores" },
  { key: "views", label: "Visualizações" },
  { key: "likes", label: "Curtidas" },
  { key: "comments", label: "Comentários" },
  { key: "shares", label: "Compartilhamentos" },
  { key: "saves", label: "Salvamentos" },
  { key: "er", label: "TE %" },
  { key: "views_per_follower", label: "Alcance (views/seguidor)" },
  { key: "date", label: "Data" },
  { key: "duration", label: "Duração (s)" },
  { key: "location", label: "Local" },
  { key: "hashtags", label: "Hashtags" },
  { key: "caption", label: "Legenda" },
  { key: "music_title", label: "Áudio" },
  { key: "music_author", label: "Autor do áudio" },
  { key: "music_url", label: "Link do áudio" },
  { key: "bio", label: "Bio" },
  { key: "subtitle", label: "Legenda automática (VTT)" },
  { key: "thumb", label: "Miniatura" },
  { key: "video", label: "Vídeo" },
];

// Small icon button overlaid on a card thumbnail.
// TikTok Sort + Download. Reads the passive fetch capture (via the TikTok content
// bridge, FBW_TT_LIST), sorts it in-panel as a 2-col grid of 9:16 cards with a
// right-side stat rail, and downloads media/thumbnail via FBW_DL_MEDIA. TikTok
// exposes shares AND saves on the list (Instagram doesn't), so the rail is richer.
export default function TtSortTool() {
  const [records, setRecords] = useState([]);
  const [surface, setSurface] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [sortKey, setSortKey] = useState("default");
  const [dateRange, setDateRange] = useState("all");
  const [sortDir, setSortDir] = useState("desc");
  const [overlay, setOverlay] = useState(true);
  const [erW, setErW] = useState(TT_ER_WEIGHTS);
  const { link, noTab, fixing, send, revive, openTab } = useContentLink("tiktok");
  // The bridge answers {unchanged:true} when its store hasn't moved since the
  // version we last saw, which makes an idle poll near-free — it otherwise
  // re-serialises the whole store every 2.5s. `null` forces a full answer, which is
  // what Atualizar wants after a clear.
  const sinceRef = useRef(null);

  useEffect(() => {
    chrome?.storage?.local?.get(["sw_tt_overlay", TT_ER_WEIGHTS_KEY]).then((r) => {
      if (r?.sw_tt_overlay != null) setOverlay(!!r.sw_tt_overlay);
      setErW(normalizeTtErWeights(r && r[TT_ER_WEIGHTS_KEY]));
    });
  }, []);
  const toggleOverlay = (v) => {
    setOverlay(v);
    chrome?.storage?.local?.set({ sw_tt_overlay: v });
  };
  // An empty box is a legitimate keystroke on the way to a number. Writing "" back
  // through Number() would give 0, which passes the guard and silently ZEROES that
  // term — so a half-typed weight is held in local state and never persisted.
  const setWeight = (k, raw) => {
    if (raw === "") { setErW((w) => ({ ...w, [k]: "" })); return; }
    const next = normalizeTtErWeights({ ...erW, [k]: raw });
    setErW(next);
    chrome?.storage?.local?.set({ [TT_ER_WEIGHTS_KEY]: next });
  };

  const [txMap, setTxMap] = useState({});
  const [savedIds, setSavedIds] = useState({});
  const [txModal, setTxModal] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!chrome?.storage?.local) return;
    const load = () =>
      chrome.storage.local.get(["fbw_transcripts", "fbw_saved"], (r) => {
        const m = r.fbw_transcripts || {};
        const out = {};
        for (const k in m) out[k] = m[k].status;
        setTxMap(out);
        const s = {};
        for (const k in r.fbw_saved || {}) s[k] = true;
        setSavedIds(s);
      });
    load();
    const onCh = (ch, area) => {
      if (area === "local" && (ch.fbw_transcripts || ch.fbw_saved)) load();
    };
    chrome.storage.onChanged.addListener(onCh);
    return () => chrome.storage.onChanged.removeListener(onCh);
  }, []);

  const listFromTab = useCallback(async () => {
    const res = await send({ type: "FBW_TT_LIST", since: sinceRef.current });
    if (!res) return;
    // Surface first: it changes on an SPA navigation with no new capture, and it
    // drives the scoping filter — skipping it on an unchanged store would keep the
    // grid filtered to the profile you just left.
    if (res.surface !== undefined) setSurface(res.surface);
    if (res.unchanged) return;
    sinceRef.current = res.version ?? sinceRef.current;
    if (res && Array.isArray(res.records)) {
      setRecords(res.records);
      setSurface(res.surface || null);
    }
  }, [send]);

  useEffect(() => {
    return startPolling(listFromTab, 2500); // skips ticks while the panel is hidden
  }, [listFromTab]);

  // Drop everything captured so far (other profiles/surfaces) and re-pull the
  // current one — so switching context doesn't leave stale videos in the grid.
  const refresh = useCallback(async () => {
    sinceRef.current = null;
    setRecords([]);
    // userAction: the user pressed Atualizar and is owed an answer either way.
    await send({ type: "FBW_TT_CLEAR" }, { userAction: true, action: "limpar a captura" });
    listFromTab();
  }, [send, listFromTab]);

  // FBW_TT_CLEAR is platform-global: it empties the capture behind every TikTok
  // pane, not just this one. So Atualizar arms on the first tap and only clears on
  // the second — the same two-step the Library's "limpar tudo" uses.
  const [clearArmed, setClearArmed] = useState(false);
  const clearBtnRef = useRef(null);
  useEffect(() => {
    if (!clearArmed) return;
    const timer = setTimeout(() => setClearArmed(false), 4000);
    // Capture phase, so a handler that stops propagation can't leave it armed.
    const disarm = (e) => { if (!clearBtnRef.current?.contains(e.target)) setClearArmed(false); };
    document.addEventListener("pointerdown", disarm, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", disarm, true);
    };
  }, [clearArmed]);
  const onClearTap = () => {
    if (!clearArmed) { setClearArmed(true); return; }
    setClearArmed(false);
    refresh();
  };

  const scopedAll = showAll ? records : filterBySurface(records, surface);
  const scoped = scopedAll.filter((r) => withinDateRange(r.create_time, dateRange));
  // The weights go in so an ER sort orders by the same number the rail prints.
  const sorted = sortRecords(scoped, sortKey, sortDir, erW);
  // Replay the grid's entrance whenever the ARRANGEMENT changes — not when a
  // single card's download finishes, which is the other reason this list
  // re-renders and no reason at all to re-animate 137 tiles.
  const stagger = useStagger(`${sortKey}|${sortDir}|${dateRange}|${showAll}`);

  // Per-action status. The key is namespaced per action: a failed COVER download
  // used to share the record's key and so painted the media-download icon red.
  const { run, statusOf, errorOf } = useItemStatus();

  async function downloadRecord(rec) {
    await run(statusKey(rec.id), async () => {
      const url = rec.hd_url || rec.download_url || rec.video; // always highest quality
      if (!url) throw new Error("sem URL de vídeo");
      await requireOk({
        type: "FBW_DL_MEDIA",
        kind: "video",
        url,
        filename: filenameFor(rec, extFromUrl(url, "video")),
      });
    });
  }

  // Own status key ("<id>:thumb") so a cover failure marks THIS button instead of
  // the video-download icon next to it.
  async function downloadThumb(rec) {
    const url = rec.cover || rec.dynamic_cover;
    if (!url) return;
    const ext = extFromUrl(url, "image");
    // The -thumb suffix marks the cover; the bucket follows the media kind.
    await run(statusKey(rec.id, "thumb"), () =>
      requireOk({ type: "FBW_DL_MEDIA", kind: "image", url, filename: thumbFilenameFor(rec, ext) }),
    );
  }

  async function downloadAll() {
    for (const rec of sorted) {
      await downloadRecord(rec);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // Ask the PAGE to scroll so TikTok paginates. The pacing lives there (scrollGapMs
  // — 3 s, then 6 s, then 10 s) because that is where the scrolling happens; the
  // panel only says how many rounds. It also has to be the page because TikTok's
  // grid scroller is <main>, not the document.
  const [scrolling, setScrolling] = useState(false);
  async function harvest(rounds) {
    if (scrolling) {
      await send({ type: "FBW_TT_SCROLL_STOP" }, { userAction: true }).catch(() => {});
      setScrolling(false);
      return;
    }
    setScrolling(true);
    const res = await send({ type: "FBW_TT_SCROLL", rounds }, { userAction: true }).catch(() => null);
    if (!res) { setScrolling(false); return; }
    // The page paces itself; this is only the panel's estimate of when it is done.
    const ms = rounds * 3000 + Math.max(0, rounds - 5) * 3000 + Math.max(0, rounds - 10) * 4000;
    setTimeout(() => setScrolling(false), ms);
  }

  function exportXlsx() {
    const rows = sorted.map((r) => {
      const er = engagementRate(r, erW);
      const vpf = ttViewsPerFollower(r);
      return {
        id: r.id || null,
        url: ttPermalink(r),
        username: r.username || null,
        followers: r.user_follower_count ?? null,
        views: r.play_count ?? null,
        likes: r.digg_count ?? null,
        comments: r.comment_count ?? null,
        shares: r.share_count ?? null,
        saves: r.collect_count ?? null,
        // Numbers stay numbers so the sheet can sort and sum them — a views column
        // exported as text is useless, which is the whole reason to export.
        er: er == null ? null : Math.round(er * 100) / 100,
        views_per_follower: vpf == null ? null : Math.round(vpf * 100) / 100,
        date: r.create_time ? new Date(r.create_time * 1000).toISOString().slice(0, 10) : null,
        duration: r.duration ?? null,
        location: r.location || null,
        hashtags: (r.hashtags || []).join(" ") || null,
        caption: r.desc || null,
        music_title: r.music?.title || null,
        music_author: r.music?.author || null,
        music_url: r.music?.url || null,
        bio: r.author_bio || null,
        subtitle: r.subtitle?.url || null,
        thumb: r.cover || r.dynamic_cover || null,
        video: r.hd_url || r.video || null,
      };
    });
    const bytes = buildXlsx(XLSX_COLS, rows, "Videos");
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    );
    const stamp = new Date().toISOString().slice(0, 10);
    chrome.downloads.download({
      // `surface` is null before the first poll answers, and stays null on a page
      // that reports none — with "mostrar tudo" the export is still legitimate, so
      // it needs a name rather than a TypeError that downloads nothing.
      url,
      filename: downloadPath("sheet", `tt-${(surface || "tudo").replace(/[^\w-]+/g, "_")}-${stamp}.xlsx`),
      saveAs: false,
      conflictAction: "uniquify",
    });
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function saveToLibrary(rec) {
    try {
      const entry = buildSavedEntry({
        id: rec.id,
        platform: "tiktok",
        thumb: rec.cover || rec.dynamic_cover,
        caption: rec.desc,
        // The card has always shown the @handle first, with the nickname only as a
        // fallback — the builder prefers authorName, so keep that order here.
        authorName: rec.username || rec.nickname,
        username: rec.username,
        // share/save too — tt-relay.js's page-side save stores them for the same
        // record, and this pane renders both, so omitting them here meant a video
        // saved from the panel carried less than one saved from the page.
        counts: {
          like: rec.digg_count,
          comment: rec.comment_count,
          view: rec.play_count,
          share: rec.share_count,
          save: rec.collect_count,
        },
        code: rec.id,
      });
      // The background owns the write and decides insert-vs-remove by whether the
      // id is already there, so it answers with the state AFTER the toggle.
      const res = await requireOk({ type: "FBW_SAVED_TOGGLE", entry });
      setSavedIds((s) => ({ ...s, [rec.id]: !!res.saved }));
    } catch (e) {
      console.warn("[fbw] salvar na biblioteca falhou", e);
    }
  }

  async function transcribe(rec) {
    if (!rec.video && !rec.subtitle) return;
    chrome.runtime.sendMessage({
      type: "FBW_TRANSCRIBE",
      videoId: rec.id,
      mediaUrl: rec.video,
      platform: "tiktok",
      language: await readStoredTranscriptLanguage(),
      captionUrl: rec.subtitle?.url || null, // caption-first, skips Whisper
      captionFormat: rec.subtitle?.format || null,
      captionLang: rec.subtitle?.lang || null, // the track's own language labels the record
      caption: rec.desc || null,
      author: {
        name: rec.username || rec.nickname || "desconhecido",
        url: rec.username ? `https://www.tiktok.com/@${rec.username}` : null,
      },
      thumb: rec.cover || rec.dynamic_cover || null,
      sourceUrl: rec.username ? `https://www.tiktok.com/@${rec.username}/video/${rec.id}` : null,
      // Raw numbers, like the Library entries — VideoCard formats at render time.
      counts: {
        like: rec.digg_count ?? null,
        comment: rec.comment_count ?? null,
        views: rec.play_count ?? null,
      },
    });
    setTxMap((m) => ({ ...m, [rec.id]: "running" }));
  }

  async function openTranscript(rec) {
    const r = await chrome.storage.local.get("fbw_transcripts");
    const t = (r.fbw_transcripts || {})[rec.id];
    if (!t?.text) return;
    setCopied(false);
    setTxModal({ id: rec.id, username: rec.username || rec.nickname || "desconhecido", text: t.text });
  }

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(txModal.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  // One banner for every link failure, rendered in every branch below so the
  // explanation (and its fix) can never be hidden by an empty state.
  const banner = (
    <ContentLinkBanner
      link={link}
      platformName="TikTok"
      fixing={fixing}
      onRevive={revive}
      onOpenTab={openTab}
    />
  );

  if (noTab) return banner;

  return (
    <div className="space-y-3">
      {banner}
      {/* TWO rows, not one. Eight controls on a single line squeezed both selects
          to "P…" and "To…" — the flexible members absorb every icon button's
          width, and a sorter that cannot show a word is not a sorter. Splitting
          them gives each select roughly half the row, which reads fully at every
          panel width the side panel actually gets. */}
      <ToolBar>
        <ToolSelect label="Ordenar por" value={sortKey} onValueChange={setSortKey} options={SORT_OPTS} />
        <ToolSelect
          label="Período"
          value={dateRange}
          onValueChange={setDateRange}
          options={DATE_RANGES.map((r) => ({ value: r.value, label: r.label, short: r.short || r.label }))}
        />
      </ToolBar>

      <ToolBar>
        <ToolIconButton
          icon={sortDir === "desc" ? ArrowDown : ArrowUp}
          label={sortDir === "desc" ? "Maior → menor" : "Menor → maior"}
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
        />
        <ToolIconButton
          ref={clearBtnRef}
          icon={clearArmed ? Trash2 : RotateCw}
          label={clearArmed ? "Confirmar limpeza" : "Atualizar"}
          hint={
            clearArmed
              ? "Toque de novo para confirmar — apaga a captura de Ordenar, Comentários, Stories e Playlists"
              : "Atualizar — limpa TODA a captura do TikTok (Ordenar, Comentários, Stories e Playlists) e recolhe esta superfície"
          }
          variant={clearArmed ? "destructive" : "outline"}
          onClick={onClearTap}
        />
        <ToolIconButton
          icon={scrolling ? Square : ChevronsDown}
          label={scrolling ? "Parar a coleta" : "Coletar (rolar 10×)"}
          hint={
            scrolling
              ? "Parar a rolagem automática"
              : "Rola a grade em ritmo humano (3 s, depois 6 s, depois 10 s) para o TikTok carregar mais vídeos"
          }
          onClick={() => harvest(10)}
        />
        <ToolIconButton
          icon={Sheet}
          label="Planilha (.xlsx)"
          hint="Exporta os vídeos listados com seguidores, TE, views por seguidor, áudio e legendas"
          onClick={exportXlsx}
          disabled={!sorted.length}
        />
        <ActionButton
          icon={Download}
          label="Tudo"
          hint="Baixar todos os vídeos listados"
          variant="secondary"
          className="basis-0 grow"
          onClick={downloadAll}
          disabled={!sorted.length}
        />
      </ToolBar>

      {/* ER weights, folded away. They are a set-once-per-niche setting, not a
          per-session control — open every time they cost two lines of the panel
          above the grid, which is the part the user is actually here to read.
          <details> keeps it zero-JS and remembers nothing, which is right: the
          numbers themselves are persisted, the disclosure is not. */}
      <details className="group rounded-lg border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs text-foreground [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 truncate">
            Peso do TE
            <span className="ml-1.5 tabular-nums text-muted-foreground">
              {erW.like}·{erW.comment}·{erW.share}·{erW.save}
            </span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        {/* TikTok exposes shares AND saves, which is why this has two terms
            Instagram's cannot. The on-page overlay reads the same stored numbers. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          {[
            ["like", "curtida"],
            ["comment", "coment."],
            ["share", "compart."],
            ["save", "salvo"],
          ].map(([k, label]) => (
            <label key={k} className="flex items-center gap-1">
              {label}
              <input
                type="number"
                min="0"
                step="1"
                value={erW[k]}
                onChange={(e) => setWeight(k, e.target.value)}
                className="w-11 rounded-md border border-border bg-background px-1 py-0.5 text-[11px] tabular-nums"
              />
            </label>
          ))}
        </div>
      </details>

      <MetricLegend weights={erW} />

      {/* flex-wrap, not truncate: when the tally and the toggle can't share a
          line the toggle drops to its own line instead of losing words. */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 break-words">
          {sorted.length} coletados{surface ? ` · ${surface}` : ""}
        </span>
        <button className="shrink-0 underline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "restringir à superfície" : "mostrar tudo"}
        </button>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <Label htmlFor="tt-overlay" className="min-w-0 cursor-pointer text-xs text-foreground">
          Sobreposição de estatísticas no TikTok
        </Label>
        <Switch id="tt-overlay" className="shrink-0" checked={overlay} onCheckedChange={toggleOverlay} />
      </div>

      {!sorted.length ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Role um perfil / hashtag / feed do TikTok para coletar vídeos e ordená-los aqui.
        </p>
      ) : (
        <div className={"grid grid-cols-2 gap-2 " + stagger}>
          {sorted.map((rec) => {
            const c = recordToCard(rec);
            const st = statusOf(statusKey(c.id));
            const stThumb = statusOf(statusKey(c.id, "thumb"));
            const er = engagementRate(rec, erW);
            const tier = reachTier(c.viewsPerFollower);
            return (
              <div
                key={c.id}
                className="group relative aspect-[9/16] overflow-hidden rounded-xl bg-muted ring-1 ring-black/5"
              >
                {c.thumb ? (
                  c.permalink ? (
                    <a href={c.permalink} target="_blank" rel="noreferrer" className="absolute inset-0">
                      <img src={c.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                    </a>
                  ) : (
                    <img src={c.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" />
                  )
                ) : null}

                {/* actions — top-left */}
                <div className="absolute left-1.5 top-1.5 flex flex-col gap-1">
                  <IconBtn
                    title={savedIds[c.id] ? "Salvo — toque para remover" : "Salvar na biblioteca"}
                    onClick={() => saveToLibrary(rec)}
                  >
                    <Bookmark className={"size-3.5 " + (savedIds[c.id] ? "fill-yellow-400 text-yellow-400" : "")} />
                  </IconBtn>
                  <IconBtn title={statusTitle("Baixar vídeo", st, errorOf(statusKey(c.id)))} onClick={() => downloadRecord(rec)} disabled={st === "downloading"}>
                    <Download className={"size-3.5 " + (st === "done" ? "text-emerald-400" : st === "error" ? "text-red-400" : "")} />
                  </IconBtn>
                  <IconBtn
                    title={statusTitle("Baixar miniatura", stThumb, errorOf(statusKey(c.id, "thumb")))}
                    onClick={() => downloadThumb(rec)}
                    disabled={stThumb === "downloading"}
                  >
                    <ImageDown
                      className={
                        "size-3.5 " +
                        (stThumb === "done" ? "text-emerald-400" : stThumb === "error" ? "text-red-400" : "")
                      }
                    />
                  </IconBtn>
                  {(rec.video || txMap[c.id] === "done") && (
                    <IconBtn
                      title={
                        txMap[c.id] === "done"
                          ? "Ver transcrição"
                          : txMap[c.id] === "error"
                            ? "Falha na transcrição — toque para tentar novamente"
                            : "Transcrever"
                      }
                      onClick={() => (txMap[c.id] === "done" ? openTranscript(rec) : transcribe(rec))}
                      disabled={txMap[c.id] === "running"}
                    >
                      {txMap[c.id] === "running" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <FileText className={"size-3.5 " + (txMap[c.id] === "done" ? "text-emerald-400" : txMap[c.id] === "error" ? "text-red-400" : "")} />
                      )}
                    </IconBtn>
                  )}
                </div>

                {/* type / pin — top-right, opens the video */}
                <a
                  href={c.permalink || undefined}
                  target="_blank"
                  rel="noreferrer"
                  title="Abrir no TikTok"
                  className="sw-hoverable absolute right-1.5 top-1.5 grid place-items-center rounded-md bg-black/55 p-1 text-white hover:bg-black/80"
                >
                  {c.pinned ? <Pin className="size-3.5" /> : <Play className="size-3.5" />}
                </a>

                {/* stat rail — right side, blue glow */}
                <div className="absolute bottom-9 right-1.5 flex flex-col items-end gap-0.5 rounded-lg border border-sky-400/30 bg-black/60 px-2 py-1.5 text-white shadow-[0_0_10px_rgba(56,130,246,0.28)]">
                  {/* REACH LEADS, and it is graded. Views say how big the number
                      is; reach says whether the FORMAT worked, independent of how
                      big the account already was — the question you are scanning a
                      hashtag grid to answer. The colour makes outliers findable
                      without reading a figure. */}
                  {tier && (
                    <div
                      className="flex items-center gap-1 text-[15px] font-extrabold leading-none"
                      style={{ color: tier.color, textShadow: `0 0 10px ${tier.color}66` }}
                      title={`${tier.label} — ${fmtRatio(c.viewsPerFollower)} o próprio público (views ÷ seguidores)`}
                    >
                      <TrendingUp className="size-3.5" />
                      {fmtRatio(c.viewsPerFollower)}
                    </div>
                  )}
                  {c.views != null && (
                    <div className={"flex items-center gap-1 leading-none " + (tier ? "text-[11.5px] font-bold" : "text-[14px] font-extrabold")}>
                      <Eye className={tier ? "size-3" : "size-3.5"} />
                      {fmtCount(c.views)}
                    </div>
                  )}
                  <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                    <Heart className="size-3" />
                    {fmtCount(c.likes)}
                  </div>
                  <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                    <MessageCircle className="size-3" />
                    {fmtCount(c.comments)}
                  </div>
                  {c.shares != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <Share2 className="size-3" />
                      {fmtCount(c.shares)}
                    </div>
                  )}
                  {c.saves != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <Bookmark className="size-3" />
                      {fmtCount(c.saves)}
                    </div>
                  )}
                  {er != null && (
                    <div className="flex items-center gap-1 text-[11.5px] font-bold leading-none">
                      <Zap className="size-3" />
                      {fmtER(er)}
                    </div>
                  )}
                  {/* Creator size, and how far past that audience the video went.
                      Free on TikTok — authorStats rides along on every list item.
                      TWO rows, not one: behind a single person icon "3.4K · 352×"
                      read as if both numbers were followers. */}
                  {c.followers != null && (
                    <div
                      className="flex items-center gap-1 text-[11.5px] font-bold leading-none"
                      title={`${fmtCount(c.followers)} seguidores`}
                    >
                      <Users className="size-3" />
                      {fmtCount(c.followers)}
                    </div>
                  )}
                  {c.date && (
                    <div className="flex items-center gap-1 text-[10.5px] font-semibold leading-none opacity-90">
                      <Calendar className="size-3" />
                      {c.date}
                    </div>
                  )}
                </div>

                {/* @username — bottom-left */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6">
                  <a
                    href={c.permalink || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="pointer-events-auto block max-w-[60%] truncate text-[12px] font-semibold text-white"
                  >
                    @{c.username}
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {txModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
          onClick={() => setTxModal(null)}
        >
          <div
            className="flex max-h-[75vh] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <FileText className="size-4 text-emerald-500" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                @{txModal.username} · {txModal.id}
              </span>
              <button
                onClick={() => setTxModal(null)}
                className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto whitespace-pre-wrap px-3 py-2.5 text-[12px] leading-relaxed text-foreground">
              {txModal.text}
            </div>
            <div className="border-t border-border p-2.5">
              <Button className="w-full" variant={copied ? "secondary" : "default"} onClick={copyTranscript}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copiado" : "Copiar transcrição"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
