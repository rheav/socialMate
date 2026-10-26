import { AnimatePresence, m } from "motion/react";
import { BadgeCheck, Check, CircleDot, ExternalLink, Pencil, Trash2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/dashboard/ui/button";
import { MOTION } from "@/dashboard/ui/motion";
import { cn } from "@/dashboard/lib/utils";
import { api, isUnauthorized, type SpyCard, type SpySnapshot } from "../api";
import { PLATFORM_META } from "../format";
import { fmtCount } from "../format";
import { dailyCounts, fmtDelta, handleFromId, postsFigure, translateError } from "./spyFormat";
import { DailyBars } from "./DailyBars";
import { TopList } from "./TopThumbs";
import { OptionChip } from "./OptionChip";
import { TagPicker, type TagMeta } from "./TagPicker";
import { useSpyDialog } from "./useSpyDialog";
import { ViewsSection } from "./ViewsSection";
import { ProfileStoriesBlock } from "./stories/ProfileStoriesBlock";
import { useCountUp } from "../effects";

// Recharts is the bulk of the dashboard bundle and only this drawer draws it.
const FollowersChart = lazy(() => import("./FollowersChart").then((m) => ({ default: m.FollowersChart })));

export interface RemovedSpyProfile { card: SpyCard; until: number }

interface ProfileSheetProps {
  profile: SpyCard | null;
  onClose: () => void;
  onUnauthorized: () => void;
  onProfileUpdate?: (updated: SpyCard) => void;
  onTagsUpdated?: (tags: TagMeta[]) => void;
  onProfileRemoved?: (removed: RemovedSpyProfile) => void;
  onProfileMerged?: (kept: SpyCard, removedId: string) => void;
}

/** With `count`, the number counts up to its value when the sheet opens (effects.ts); `value` is shown as given. */
function StatBox({ label, value, count }: { label: string; value: string | null; count?: number | null }) {
  const shown = useCountUp(count);
  return (
    <div className="min-w-0 rounded-lg border bg-card/60 px-3 py-2">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="truncate text-base font-semibold tabular-nums text-foreground">
        {count != null && shown != null ? fmtCount(shown) : value ?? "—"}
      </div>
    </div>
  );
}

function DeltaBox({
  label,
  delta,
}: {
  label: string;
  delta: number | null;
}) {
  const text = fmtDelta(delta);
  return (
    <div className="min-w-0 rounded-lg border bg-card/60 px-3 py-2">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "truncate text-sm font-semibold tabular-nums",
          delta != null && delta > 0 && "text-good",
          delta != null && delta < 0 && "text-danger",
          (delta === 0 || delta == null) && "text-muted-foreground"
        )}
      >
        {text ?? "—"}
      </div>
    </div>
  );
}

export function ProfileSheet({
  profile,
  onClose,
  onUnauthorized,
  onProfileUpdate,
  onTagsUpdated,
  onProfileMerged,
  onProfileRemoved,
}: ProfileSheetProps) {
  const [snapshots, setSnapshots] = useState<SpySnapshot[]>([]);
  const inflight = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const dirtyNotesRef = useRef(false);
  // Closing never discards typed text silently: point back at the editor
  // instead; Cancelar or Salvar settle it.
  const requestClose = () => {
    if (dirtyNotesRef.current) {
      setEditError("Há uma anotação não salva. Salve ou cancele antes de fechar.");
      notesRef.current?.focus();
      return;
    }
    onClose();
  };
  useSpyDialog(!!profile, dialogRef, requestClose);
  const mutationBusy = useRef(false);
  const [savingTags, setSavingTags] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [confirmMerge, setConfirmMerge] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  const [notes, setNotes] = useState(profile?.notes ?? "");
  const [draftNotes, setDraftNotes] = useState(profile?.notes ?? "");
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  // A note already on its way to the server is not at risk.
  dirtyNotesRef.current = isEditingNotes && !savingNotes && draftNotes !== notes;

  const [tags, setTags] = useState<string[]>(profile?.tags ?? []);
  const [allTags, setAllTags] = useState<TagMeta[]>([]);

  useEffect(() => {
    setNotes(profile?.notes ?? "");
    if (!isEditingNotes) setDraftNotes(profile?.notes ?? "");
  }, [profile?.notes, isEditingNotes]);

  useEffect(() => {
    setTags(profile?.tags ?? []);
  }, [profile?.tags]);

  // Load all tags for picker
  useEffect(() => {
    if (!profile) return;
    api.spy.tags
      .list()
      .then((res) => {
        setAllTags(res.tags);
        onTagsUpdated?.(res.tags);
      })
      .catch(() => {});
  }, [profile?.id]);

  const allTagsMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const t of allTags) {
      map[t.name.toLowerCase()] = t.color;
    }
    return map;
  }, [allTags]);

  useEffect(() => {
    if (!confirmingRemove) return;
    const timer = setTimeout(() => setConfirmingRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingRemove]);

  const handleRemove = async () => {
    if (!profile || mutationBusy.current) return;
    if (dirtyNotesRef.current) {
      setEditError("Há uma anotação não salva. Salve ou cancele antes de excluir.");
      notesRef.current?.focus();
      return;
    }
    if (!confirmingRemove) { setConfirmingRemove(true); return; }
    mutationBusy.current = true;
    setRemoving(true);
    setConfirmingRemove(false);
    setRemoveError(null);
    try {
      const res = await api.spy.remove(profile.id);
      onProfileRemoved?.({ card: profile, until: res.restorableUntil ?? Date.now() + 7 * 86_400_000 });
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setRemoveError("Não consegui excluir o perfil. Tente novamente.");
    } finally {
      mutationBusy.current = false;
      setRemoving(false);
    }
  };

  const handleSaveNotes = async () => {
    if (!profile || mutationBusy.current) return;
    mutationBusy.current = true;
    setSavingNotes(true);
    setEditError(null);
    try {
      const updated = await api.spy.updateProfile(profile.id, { notes: draftNotes });
      setNotes(draftNotes);
      setIsEditingNotes(false);
      onProfileUpdate?.(updated);
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setEditError("Não consegui salvar a anotação. Seu rascunho foi mantido; tente novamente.");
    } finally {
      mutationBusy.current = false;
      setSavingNotes(false);
    }
  };

  const handleCancelNotes = () => {
    setDraftNotes(notes);
    setIsEditingNotes(false);
  };

  const handleTagsChange = async (nextTags: string[]) => {
    if (!profile || mutationBusy.current) return;
    mutationBusy.current = true;
    setSavingTags(true);
    setEditError(null);
    const previous = tags;
    setTags(nextTags);
    try {
      const updated = await api.spy.updateProfile(profile.id, { tags: nextTags });
      setTags(updated.tags);
      onProfileUpdate?.(updated);
    } catch (err) {
      setTags(previous);
      if (isUnauthorized(err)) onUnauthorized();
      else setEditError("Não consegui salvar as tags. Tente novamente.");
    } finally {
      mutationBusy.current = false;
      setSavingTags(false);
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    const nextTags = tags.filter((t) => t.toLowerCase() !== tagToRemove.toLowerCase());
    void handleTagsChange(nextTags);
  };

  const handleCreateTag = async (tag: { name: string; color: string }) => {
    try {
      const res = await api.spy.tags.add([tag]);
      setAllTags(res.tags);
      onTagsUpdated?.(res.tags);
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setEditError("Não consegui criar a tag. Tente novamente.");
      throw err;
    }
  };

  const handleRecolorTag = async (name: string, nextColor: string) => {
    setEditError(null);
    try {
      await api.spy.tags.recolor(name, nextColor);
      const next = allTags.map((t) => t.name.toLowerCase() === name.toLowerCase() ? { ...t, color: nextColor } : t);
      setAllTags(next);
      onTagsUpdated?.(next);
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setEditError("Não consegui alterar a cor. Tente novamente.");
    }
  };

  // Fetch full snapshot history
  useEffect(() => {
    if (!profile) {
      setSnapshots([]);
      return;
    }

    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;

    setHistoryError(false);
    setSnapshots([]);
    // Start with whatever snapshots the card already has
    if (profile.spark && profile.spark.length > 0) {
      setSnapshots(
        profile.spark.map((s) => ({
          day: s.day,
          measuredAt: 0,
          followers: s.followers,
          followersApprox: profile.latest?.followersApprox ?? false,
          following: profile.latest?.following ?? null,
          posts: profile.latest?.posts ?? null,
          hasStory: profile.latest?.hasStory ?? null,
          source: profile.latest?.source ?? "daily",
        }))
      );
    }

    api.spy
      .history(profile.id, ac.signal)
      .then((res) => {
        if (!ac.signal.aborted) setSnapshots(res.snapshots);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        if (isUnauthorized(err)) onUnauthorized();
        else setHistoryError(true);
      });

    return () => ac.abort();
  }, [profile?.id, onUnauthorized, historyRetry]);

  if (!profile) return null;

  const meta = PLATFORM_META[profile.platform] ?? {
    label: profile.platform,
    color: "#aeb9cd",
  };

  const isNumericKey = /^\d+$/.test(profile.key);
  const latest = profile.latest;
  const hasStory = latest?.hasStory === true;
  const errText = translateError(profile.lastError);

  // Growth figures come from the hub, which reads the whole history and only
  // compares with a measurement near the period's age.
  const { delta7, delta30, deltaTotal } = profile;

  const followersDisplay =
    latest?.followers != null ? fmtCount(latest.followers) : null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex justify-end">
        {/* Backdrop */}
        <m.button
          type="button"
          aria-label="Fechar"
          onClick={requestClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={MOTION.fade}
          className="absolute inset-0 cursor-pointer bg-black/60 backdrop-blur-[2px]"
        />

        {/* Drawer */}
        <m.aside
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Detalhes de ${profile.name || profile.key}`}
          tabIndex={-1}
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={MOTION.sheet}
          className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l bg-card shadow-2xl"
        >
          {/* Header */}
          <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-card/95 px-5 py-4 backdrop-blur">
            <span
              className="rounded-full px-2.5 py-0.5 text-[10px] font-medium text-[#232833]"
              style={{ background: meta.color }}
            >
              {meta.label}
            </span>

            <div className="flex items-center gap-1.5">
              <a
                href={profile.profileUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                title="Abrir perfil"
              >
                <ExternalLink size={16} />
              </a>

              {profile.storiesUrl && (
                <a
                  href={profile.storiesUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  title="Abrir stories"
                >
                  <CircleDot size={16} />
                </a>
              )}

              <button
                type="button"
                onClick={requestClose}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer"
                title="Fechar (Esc)"
              >
                <X size={18} />
              </button>
            </div>
          </header>

          <div className="space-y-6 p-6">
            {editError && <p role="alert" className="text-xs text-destructive">{editError}</p>}
            {/* Profile Hero: Avatar 72px, Name, @key on the left, Notes field on the right */}
            <div className="flex flex-col sm:flex-row sm:items-start gap-4 justify-between">
              <div className="flex items-center gap-3.5 min-w-0 sm:max-w-[240px] shrink-0">
                <div
                  className="relative shrink-0 rounded-full"
                  style={{
                    boxShadow: hasStory ? `0 0 0 2px ${meta.color}` : undefined,
                  }}
                >
                  {profile.avatarUrl ? (
                    <img
                      src={profile.avatarUrl}
                      alt=""
                      className="h-[72px] w-[72px] rounded-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="grid h-[72px] w-[72px] place-items-center rounded-full bg-secondary text-2xl font-bold text-foreground">
                      {(profile.name || profile.key).charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <h2 className="truncate text-lg font-bold text-foreground">
                      {profile.name || `@${profile.key}`}
                    </h2>
                    {profile.verified && (
                      <BadgeCheck
                        size={18}
                        className="shrink-0 text-primary"
                        aria-label="Verificado"
                      />
                    )}
                  </div>
                  {profile.name && !isNumericKey && (
                    <p className="truncate text-xs text-muted-foreground mt-0.5">
                      @{profile.key}
                    </p>
                  )}
                </div>
              </div>

              {/* Right: Notes Box (Locked textarea by default, pencil to edit, save button) */}
              <div className="relative flex-1 min-w-[220px]">
                {isEditingNotes ? (
                  <div className="rounded-xl border border-primary/50 bg-background/90 p-2.5 shadow-sm transition-all flex flex-col justify-between">
                    <textarea
                      ref={notesRef}
                      aria-label="Anotação do perfil"
                      maxLength={10_000}
                      disabled={savingNotes || savingTags || removing}
                      value={draftNotes}
                      onChange={(e) => setDraftNotes(e.target.value)}
                      placeholder="Adicionar nota sobre este perfil…"
                      autoFocus
                      rows={3}
                      className="w-full resize-none bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none leading-relaxed"
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                          e.preventDefault();
                          void handleSaveNotes();
                        } else if (e.key === "Escape") {
                          // Never let Escape close the drawer over unsaved text;
                          // a clean editor just leaves edit mode.
                          e.preventDefault();
                          if (draftNotes === notes) handleCancelNotes();
                        }
                      }}
                    />
                    <div className="flex items-center justify-end gap-1.5 pt-2 border-t border-border/40 mt-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleCancelNotes}
                        disabled={savingNotes || savingTags || removing}
                        className="h-6 px-2 text-[11px] cursor-pointer"
                      >
                        Cancelar
                      </Button>
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={handleSaveNotes}
                        disabled={savingNotes || savingTags || removing}
                        className="h-6 px-2.5 text-[11px] gap-1 cursor-pointer"
                      >
                        <Check size={11} />
                        {savingNotes ? "Salvando…" : "Salvar"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="group relative min-h-[72px] rounded-xl border border-border/70 bg-secondary/25 p-2.5 flex flex-col justify-between transition-colors hover:border-border">
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 select-none">
                        Anotações
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setDraftNotes(notes);
                          setIsEditingNotes(true);
                        }}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer"
                        title="Editar anotação"
                      >
                        <Pencil size={11} />
                        <span className="text-[10px]">Editar</span>
                      </button>
                    </div>

                    {notes.trim() ? (
                      <div className="max-h-24 overflow-y-auto text-xs text-foreground/90 whitespace-pre-wrap select-text leading-relaxed font-sans">
                        {notes}
                      </div>
                    ) : (
                      <div
                        onClick={() => {
                          setDraftNotes("");
                          setIsEditingNotes(true);
                        }}
                        className="cursor-pointer text-xs italic text-muted-foreground/60 transition-colors hover:text-muted-foreground py-1"
                      >
                        Nenhuma anotação… clique para escrever.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Tags row */}
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {tags.map((tag) => (
                <OptionChip
                  key={tag}
                  value={tag}
                  color={allTagsMap[tag.toLowerCase()]}
                  disabled={savingNotes || savingTags || removing}
                  onRemove={() => handleRemoveTag(tag)}
                />
              ))}
              <TagPicker
                disabled={savingNotes || savingTags || removing}
                selected={tags}
                allTags={allTags}
                onChange={handleTagsChange}
                onCreateTag={handleCreateTag}
                onRecolorTag={handleRecolorTag}
              />
            </div>

            {/* Stories: Instagram only (the capture reads Instagram's stories page). */}
            {profile.platform === "instagram" && (
              <ProfileStoriesBlock profile={profile} onProfileUpdate={onProfileUpdate} onUnauthorized={onUnauthorized} />
            )}

            {/* Bio & External URL */}
            {(profile.bio || profile.externalUrl) && (
              <div className="space-y-2 rounded-xl border bg-card/40 p-4">
                {profile.bio && (
                  <p className="text-xs text-foreground/90 whitespace-pre-line line-clamp-6 leading-relaxed">
                    {profile.bio}
                  </p>
                )}
                {profile.externalUrl && (
                  <a
                    href={profile.externalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline break-all"
                  >
                    <ExternalLink size={12} className="shrink-0" />
                    {profile.externalUrl}
                  </a>
                )}
              </div>
            )}

            {(profile.sameAccountAs ?? []).map((otherId) => (
              <div key={otherId} className="rounded-xl border border-amber/40 bg-amber/5 p-3 text-xs leading-relaxed">
                <p className="text-foreground">
                  {handleFromId(otherId)} é a mesma conta (mesmo ID da rede): nome trocado ou salvo de outro jeito.
                </p>
                <p className="mt-1 text-muted-foreground">
                  Mesclar traz o histórico, as tags e as notas de {handleFromId(otherId)} para cá e tira {handleFromId(otherId)} da lista.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={confirmMerge === otherId ? "default" : "outline"}
                    disabled={merging}
                    className="h-7 px-2.5 text-[11px]"
                    onClick={async () => {
                      if (confirmMerge !== otherId) { setConfirmMerge(otherId); return; }
                      setMerging(true);
                      setEditError(null);
                      try {
                        const { profile: kept } = await api.spy.merge(profile.id, otherId);
                        setConfirmMerge(null);
                        setHistoryRetry((n) => n + 1);
                        onProfileMerged?.(kept, otherId);
                      } catch (err) {
                        if (isUnauthorized(err)) onUnauthorized();
                        else setEditError("Não consegui mesclar os perfis. Tente novamente.");
                      } finally {
                        setMerging(false);
                      }
                    }}
                  >
                    {confirmMerge === otherId ? "Confirmar mesclagem" : "Mesclar histórico"}
                  </Button>
                  {confirmMerge === otherId && (
                    <Button type="button" size="sm" variant="ghost" className="h-7 px-2.5 text-[11px]" onClick={() => setConfirmMerge(null)}>
                      Cancelar
                    </Button>
                  )}
                </div>
              </div>
            ))}

            {/* Followers Chart */}
            <div className="rounded-xl border bg-card/40 p-4">
              <div className="mb-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Evolução de Seguidores
              </div>
              {historyError && <p role="alert" className="mb-2 text-xs text-destructive">
                Não consegui carregar o histórico completo. <button type="button" className="underline" onClick={() => setHistoryRetry((n) => n + 1)}>Tentar novamente</button>
              </p>}
              <Suspense fallback={<div className="h-[260px] w-full rounded-xl border bg-card/40" />}>
                <FollowersChart snapshots={snapshots} />
              </Suspense>
            </div>

            {/* Stats Row: Seguidores, Seguindo, Posts (reels on Facebook) */}
            <div>
              <div className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Métricas Atuais
              </div>
              <div className="grid grid-cols-3 gap-2">
                <StatBox label="Seguidores" value={followersDisplay} count={latest?.followersApprox ? null : latest?.followers} />
                <StatBox
                  label="Seguindo"
                  value={latest?.following != null ? fmtCount(latest.following) : null}
                  count={latest?.following}
                />
                {(() => {
                  const posts = postsFigure(profile);
                  return <StatBox label={posts.label === "reels" ? "Reels" : "Posts"} value={posts.value === "—" ? null : posts.value} />;
                })()}
              </div>
            </div>

            {/* Views of the reels per period, per day and over time */}
            <ViewsSection profile={profile} onUnauthorized={onUnauthorized} />

            {/* Top 3 of the last 7 days */}
            <div>
              <div className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Top 3 da semana{profile.top && !profile.top.complete && profile.top.items.length > 0 ? " · parcial" : ""}
              </div>
              <div className="rounded-xl border bg-card/40 p-3 space-y-2">
                <TopList items={profile.top?.items ?? []} />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {profile.platform === "facebook"
                    ? "Reels dos últimos 7 dias com mais visualizações (o Facebook mostra o número abreviado), atualizados a cada leitura."
                    : "Reels dos últimos 7 dias com mais visualizações; sem reels suficientes, os posts com mais curtidas. Atualizados a cada leitura."}
                </p>
              </div>
            </div>

            {/* Posts (reels on Facebook) per day, last 14 days */}
            {(() => {
              const daily = dailyCounts(profile.daily);
              const title = daily.label === "reels" ? "Reels por dia" : "Posts por dia";
              return (
                <div>
                  <div className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</div>
                  <div className="rounded-xl border bg-card/40 p-3">
                    <DailyBars days={daily.days} label={daily.label} className="h-10" />
                    <table className="mt-3 w-full text-xs">
                      <tbody>
                        {daily.days.map((d, i) => (
                          <tr key={d.key} className="border-t border-border/40 first:border-t-0">
                            <td className="py-1 text-muted-foreground">
                              {i === 0 ? "Hoje" : i === 1 ? "Ontem" : d.start.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })}
                            </td>
                            <td className="py-1 text-right tabular-nums font-medium text-foreground">{d.count ?? "—"}</td>
                            <td className="w-32 py-1 pl-3 text-right text-[11px] text-muted-foreground">
                              {d.count == null ? "sem dados" : i === 0
                                ? (profile.daily?.readAt ? `até ${new Date(profile.daily.readAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "parcial")
                                : d.partial ? "parcial" : ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      {daily.label === "reels"
                        ? "Reels do Facebook pela data de publicação. Completo depois da leitura inicial dos reels."
                        : "Posts publicados pelo perfil (ou em parceria com ele), pela data de publicação no seu fuso, vistos a cada leitura do grid. A primeira leitura de um perfil busca até 15 dias. Dias antes disso ficam sem dados."}
                    </p>
                  </div>
                </div>
              );
            })()}

            {/* Variations Row: 7d, 30d, Total */}
            <div>
              <div className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Variação de Seguidores
              </div>
              <div className="grid grid-cols-3 gap-2">
                <DeltaBox label="7 dias" delta={delta7} />
                <DeltaBox label="30 dias" delta={delta30} />
                <DeltaBox label="Desde o início" delta={deltaTotal} />
              </div>
            </div>

            {/* Footer info */}
            <div className="border-t border-border/50 pt-4 text-xs text-muted-foreground space-y-1">
              <div>
                Salvo em:{" "}
                <span className="text-foreground">
                  {new Date(profile.savedAt).toLocaleDateString("pt-BR")}
                </span>
              </div>
              <div>
                Última medição:{" "}
                <span className="text-foreground">
                  {profile.lastMeasuredAt
                    ? new Date(profile.lastMeasuredAt).toLocaleString("pt-BR")
                    : "aguardando primeira medição"}
                </span>
              </div>
              {errText && (
                <div className="text-amber mt-2">
                  Aviso: {errText}
                </div>
              )}
            </div>
            <div className="border-t border-border/50 pt-4">
              {removeError && <p role="alert" className="mb-3 text-xs text-destructive">{removeError}</p>}
              {confirmingRemove && (
                <p className="mb-3 text-xs text-muted-foreground">
                  Sai da lista do Hub e da extensão. Histórico, tags e notas ficam guardados por 7 dias: dá para desfazer.
                </p>
              )}
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={removing || savingNotes || savingTags || merging}
                onClick={handleRemove}
              >
                <Trash2 size={14} aria-hidden="true" />
                {removing ? "Excluindo…" : confirmingRemove ? "Confirmar exclusão" : "Excluir"}
              </Button>
            </div>
          </div>
        </m.aside>
      </div>
    </AnimatePresence>
  );
}
