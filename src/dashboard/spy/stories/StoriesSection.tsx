import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import { Segmented } from "@/dashboard/ui/segmented";
import { Skeleton } from "@/dashboard/ui/skeleton";
import { cn } from "@/dashboard/lib/utils";
import { ApiError, api, isUnauthorized, type CommandState, type SpyCard, type SpyStoriesList, type SpyStory, type StoriesPeriod } from "../../api";
import { StoriesTray, AccountAvatar } from "./StoriesTray";
import { StoryDeck } from "./StoryDeck";
import { StoryCard } from "./StoryCard";
import { StoryViewer } from "./StoryViewer";
import { PERIOD_LABELS, accountName, agoLabel, groupByDay, instagramStoriesUrl, readSeenAt, writeSeenAt } from "./storiesFormat";
import "./stories.css";

// The Stories section of the Spy page: the swipe file. A tray of the
// tracked accounts on top, one deck per account below; a deck opens its row in
// place, a tray account takes the whole section. Names, avatars and tags come
// from the profiles already loaded; counts and stories from the local database.
// Lightness: posters only (lazy), no video outside the viewer, effects in CSS.

export interface StoriesSectionProps {
  profiles: SpyCard[];
  /** From the URL: #spy/stories/<profileId> focuses one account. */
  profileId: string | null;
  onFocusChange: (profileId: string | null) => void;
  onSelectProfile: (profile: SpyCard) => void;
  onUnauthorized: () => void;
  refreshKey: number;
}

const PERIODS = (Object.keys(PERIOD_LABELS) as Exclude<StoriesPeriod, "starred">[]).map((key) => ({ key, label: PERIOD_LABELS[key] }));
/** How often the page asks how the collection is going. */
const COLLECT_POLL_MS = 2500;

/** What a failed collection means, in plain words. */
function collectError(code: string | null): string {
  switch (code) {
    case "extension_timeout": return "A extensão não respondeu em 2 min.";
    case "rate_limited": return "O Instagram limitou a leitura; a passada parou.";
    case "login_required": return "O Instagram pediu login; abra o Instagram no Chrome e tente de novo.";
    case "busy": return "A extensão já está numa passada; tente daqui a pouco.";
    case "already_collecting": return "Já tem uma coleta em andamento; os stories chegam em instantes.";
    case "nothing_tracked": return "Ligue “Trackear stories” em pelo menos um perfil.";
    default: return `A coleta falhou: ${code ?? "erro desconhecido"}.`;
  }
}

export default function StoriesSection({ profiles, profileId, onFocusChange, onSelectProfile, onUnauthorized, refreshKey }: StoriesSectionProps) {
  const [period, setPeriod] = useState<StoriesPeriod>("live");
  // "Favoritos" ignores the period; the one before it comes back when it is left.
  const [lastPeriod, setLastPeriod] = useState<Exclude<StoriesPeriod, "starred">>("live");
  const favourites = period === "starred";
  const [tag, setTag] = useState<string | null>(null);
  const [onlyVideo, setOnlyVideo] = useState(false);
  const [onlyLink, setOnlyLink] = useState(false);
  const [data, setData] = useState<SpyStoriesList | null>(null);
  const [failed, setFailed] = useState(false);
  const [keepDays, setKeepDays] = useState<number | null>(null);
  const [openDeck, setOpenDeck] = useState<string | null>(null);
  // The viewer walks one account's list, in the order shown.
  const [viewer, setViewer] = useState<{ account: SpyCard; list: SpyStory[]; index: number } | null>(null);
  // "Coletar stories": a stories pass in the service worker, followed by polling.
  const [collecting, setCollecting] = useState<CommandState | null>(null);
  const [collectFailed, setCollectFailed] = useState<string | null>(null);
  const openViewer = (account: SpyCard, list: SpyStory[], story: SpyStory) =>
    setViewer({ account, list, index: Math.max(0, list.findIndex((s) => s.id === story.id)) });
  // A star shows at once and is told to the hub; the hub's answer (or a failure) settles it.
  const [starFailed, setStarFailed] = useState<string | null>(null);
  const applyStar = (id: string, starredAt: number | null) => {
    setData((d) => (d ? { ...d, stories: d.stories.map((s) => (s.id === id ? { ...s, starredAt } : s)) } : d));
    setViewer((v) => (v ? { ...v, list: v.list.map((s) => (s.id === id ? { ...s, starredAt } : s)) } : v));
  };
  const toggleStar = async (story: SpyStory) => {
    const next = story.starredAt == null;
    applyStar(story.id, next ? Date.now() : null);
    try {
      const { story: saved } = await api.spy.stories.star(story.id, next);
      applyStar(saved.id, saved.starredAt);
    } catch (err) {
      applyStar(story.id, story.starredAt);
      if (isUnauthorized(err)) onUnauthorized();
      else setStarFailed("Não consegui salvar o favorito. Tente novamente.");
    }
  };
  // Read once: what counts as "new" stays fixed while the section is open and
  // moves forward when it closes.
  const seenAt = useRef(readSeenAt());
  const latestNow = useRef(0);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setFailed(false);
    try {
      const list = await api.spy.stories.list(period, profileId ?? undefined, controller.signal);
      if (controller.signal.aborted) return;
      latestNow.current = list.now;
      setData(list);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (isUnauthorized(err)) onUnauthorized();
      else setFailed(true);
    }
  }, [period, profileId, onUnauthorized]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => () => inflight.current?.abort(), []);
  useEffect(() => {
    api.spy.settings.get().then((s) => setKeepDays(s.stories.keepDays)).catch((err) => { if (isUnauthorized(err)) onUnauthorized(); });
  }, [onUnauthorized]);
  useEffect(() => () => { if (latestNow.current) writeSeenAt(latestNow.current); }, []);

  const startCollect = async () => {
    setCollectFailed(null);
    try {
      const { requestId } = await api.spy.stories.collect();
      setCollecting({ requestId, command: "stories.collect", startedAt: Date.now(), updatedAt: Date.now(), done: false, ok: null, error: null, progress: {} });
    } catch (err) {
      if (isUnauthorized(err)) { onUnauthorized(); return; }
      setCollectFailed(collectError(err instanceof ApiError ? err.code ?? null : null));
    }
  };
  // Poll the request while it is alive; reload the stories when it ends well.
  useEffect(() => {
    if (!collecting || collecting.done) return;
    let stopped = false;
    const poll = async () => {
      try {
        const { request } = await api.spy.stories.collectStatus(collecting.requestId);
        if (stopped) return;
        setCollecting(request);
        if (request.done) {
          if (request.ok) void load();
          else setCollectFailed(collectError(request.error));
        }
      } catch (err) {
        if (stopped) return;
        if (isUnauthorized(err)) onUnauthorized();
        else { setCollecting(null); setCollectFailed("Perdi o andamento da coleta; os stories chegam mesmo assim."); }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), COLLECT_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [collecting?.requestId, collecting?.done, load, onUnauthorized]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const tags = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of data?.tray ?? []) for (const t of byId.get(entry.profileId)?.tags ?? []) names.set(t.toLowerCase(), t);
    return [...names.values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [data, byId]);

  const stories = useMemo(() => (data?.stories ?? []).filter((s) => {
    const profile = byId.get(s.profileId);
    if (!profile) return false;
    if (profileId && s.profileId !== profileId) return false;
    if (tag && !profile.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
    if (onlyVideo && s.mediaType !== 2) return false;
    if (onlyLink && s.links.length === 0) return false;
    return true;
  }), [data, byId, profileId, tag, onlyVideo, onlyLink]);

  const byProfile = useMemo(() => {
    const groups = new Map<string, SpyStory[]>();
    for (const s of stories) {
      const list = groups.get(s.profileId);
      if (list) list.push(s);
      else groups.set(s.profileId, [s]);
    }
    return groups;
  }, [stories]);
  const newCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of data?.stories ?? []) if (s.capturedAt > seenAt.current) counts.set(s.profileId, (counts.get(s.profileId) ?? 0) + 1);
    return counts;
  }, [data]);

  const tray = (data?.tray ?? []).filter((entry) => byId.has(entry.profileId));
  const focus = profileId ? byId.get(profileId) ?? null : null;
  const now = data?.now ?? Date.now();
  const deckAccounts = tray.filter((entry) => byProfile.has(entry.profileId));

  const toggleChip = (label: string, on: boolean, flip: () => void) => (
    <button type="button" className={cn("sm-chip", on && "on")} aria-pressed={on} onClick={flip}>{label}</button>
  );

  return (
    <section className="sm-stories" data-slot="stories" data-ready={data ? "true" : undefined} aria-label="Stories">
      {data && (
        <StoriesTray entries={tray} profiles={byId} selected={profileId} newCounts={newCounts}
          onSelect={(id) => { setOpenDeck(null); onFocusChange(id); }} />
      )}
      <div className="sm-bar">
        <span className={cn(favourites && "sm-bar-dim")}>
          <Segmented value={favourites ? lastPeriod : period} options={PERIODS}
            onChange={(key) => { setOpenDeck(null); setLastPeriod(key as Exclude<StoriesPeriod, "starred">); setPeriod(key); }} />
        </span>
        {tags.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            {toggleChip("Todas as tags", tag === null, () => setTag(null))}
            {tags.map((t) => toggleChip(t, tag?.toLowerCase() === t.toLowerCase(), () => setTag(tag?.toLowerCase() === t.toLowerCase() ? null : t)))}
          </>
        )}
        <span aria-hidden="true">·</span>
        {toggleChip("Vídeo", onlyVideo, () => setOnlyVideo((v) => !v))}
        {toggleChip("Com link", onlyLink, () => setOnlyLink((v) => !v))}
        {toggleChip("Favoritos", favourites, () => { setOpenDeck(null); setPeriod(favourites ? lastPeriod : "starred"); })}
        <span className="sm-summary flex items-center gap-3">
          <button
            type="button"
            className="sm-collect"
            aria-label="Coletar stories"
            disabled={!!collecting && !collecting.done}
            title={collecting && !collecting.done ? "Coletando…" : "Faz uma passada de stories agora"}
            onClick={() => void startCollect()}
          >
            <Download size={14} />
            Coletar stories
          </button>
          {collecting && !collecting.done ? (
            <span aria-live="polite">
              Coletando… {Number(collecting.progress.done ?? 0)} de {Number(collecting.progress.total ?? 0)} contas · {Number(collecting.progress.added ?? 0)} novos
            </span>
          ) : data && (
            <span>
              {data.stories.length} {data.stories.length === 1 ? "story" : "stories"} · {data.tray.length} {data.tray.length === 1 ? "conta" : "contas"}
              {keepDays != null && ` · guardando ${keepDays} ${keepDays === 1 ? "dia" : "dias"}`}
            </span>
          )}
        </span>
      </div>
      {collectFailed && (
        <p role="alert" className="mb-4 text-sm text-destructive">{collectFailed} <button type="button" className="underline" onClick={() => setCollectFailed(null)}>ok</button></p>
      )}
      {starFailed && (
        <p role="alert" className="mb-4 text-sm text-destructive">{starFailed} <button type="button" className="underline" onClick={() => setStarFailed(null)}>ok</button></p>
      )}

      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          Não consegui carregar os stories. <button type="button" className="underline" onClick={() => void load()}>Tentar novamente</button>
        </p>
      ) : !data ? (
        <div className="sm-decks">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[260px] rounded-[var(--radius-card)]" />)}</div>
      ) : focus ? (
        <FocusView account={focus} stories={byProfile.get(focus.id) ?? []} now={now} onSelectProfile={onSelectProfile}
          onOpen={(story) => openViewer(focus, byProfile.get(focus.id) ?? [], story)} onToggleStar={toggleStar} />
      ) : tray.length === 0 ? (
        <p className="sm-empty">{favourites ? "Nenhum favorito ainda. A estrela num story guarda ele para sempre." : "Nenhum story guardado. Ligue “Trackear stories” num perfil."}</p>
      ) : deckAccounts.length === 0 ? (
        <p className="sm-empty">Nenhum story com esses filtros.</p>
      ) : (
        <div className="sm-decks">
          {deckAccounts.map((entry, i) => {
            const account = byId.get(entry.profileId)!;
            const list = byProfile.get(entry.profileId)!;
            const open = openDeck === entry.profileId;
            return [
              <StoryDeck key={entry.profileId} account={account} stories={list} fresh={newCounts.get(entry.profileId) ?? 0} open={open} now={now}
                index={i} onToggle={() => setOpenDeck(open ? null : entry.profileId)} />,
              open && (
                <div key={`${entry.profileId}:open`} data-slot="expanded" className="sm-expanded">
                  <div className="sm-expanded-head">
                    <AccountAvatar profile={account} />
                    <b>{accountName(account)}</b>
                    <span className="text-muted-foreground">{list.length} {list.length === 1 ? "story" : "stories"} · último {agoLabel(list[0].takenAt, now)}</span>
                    <span className="ml-auto flex gap-4">
                      <button type="button" className="sm-link" onClick={() => onFocusChange(entry.profileId)}>Ver tudo de {accountName(account)} →</button>
                      <button type="button" className="sm-link" onClick={() => setOpenDeck(null)}>Fechar</button>
                    </span>
                  </div>
                  <div className="sm-row">{list.map((s, i) => <StoryCard key={s.id} story={s} index={i} onOpen={() => openViewer(account, list, s)} onToggleStar={toggleStar} />)}</div>
                </div>
              ),
            ];
          })}
        </div>
      )}
      {viewer && (
        <StoryViewer stories={viewer.list} index={viewer.index} account={viewer.account}
          onIndex={(index) => setViewer((v) => (v ? { ...v, index } : v))} onClose={() => setViewer(null)} onToggleStar={toggleStar} />
      )}
    </section>
  );
}

function FocusView({ account, stories, now, onSelectProfile, onOpen, onToggleStar }: {
  account: SpyCard; stories: SpyStory[]; now: number; onSelectProfile: (p: SpyCard) => void; onOpen: (story: SpyStory) => void;
  onToggleStar: (story: SpyStory) => void;
}) {
  const days = groupByDay(stories, now);
  return (
    <section data-slot="focus" aria-label={`Stories de ${accountName(account)}`}>
      <div className="sm-focus-head">
        <AccountAvatar profile={account} />
        <div className="min-w-0">
          <div className="sm-focus-name">{accountName(account)}</div>
          <div className="sm-focus-when">
            {stories.length} {stories.length === 1 ? "story guardado" : "stories guardados"}
            {stories[0] && ` · último ${agoLabel(stories[0].takenAt, now)}`}
          </div>
          {account.tags.length > 0 && <div className="sm-focus-tags">{account.tags.map((t) => <span key={t}>{t}</span>)}</div>}
        </div>
        <div className="sm-focus-actions">
          <a href={instagramStoriesUrl(account.key)} target="_blank" rel="noreferrer">Abrir no Instagram ↗</a>
          <button type="button" onClick={() => onSelectProfile(account)}>Ver perfil</button>
        </div>
      </div>
      {days.length === 0 ? (
        <p className="sm-empty">Nenhum story guardado neste período.</p>
      ) : days.map((day) => (
        <div key={day.label} className="sm-day">
          <div className="sm-daysep">{day.label} · {day.items.length}</div>
          <div className="sm-row">{day.items.map((s, i) => <StoryCard key={s.id} story={s} index={i} onOpen={() => onOpen(s)} onToggleStar={onToggleStar} />)}</div>
        </div>
      ))}
    </section>
  );
}
