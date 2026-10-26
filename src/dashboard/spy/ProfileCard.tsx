import { BadgeCheck, CircleDot, ExternalLink } from "lucide-react";
import { cn } from "@/dashboard/lib/utils";
import type { SpyCard } from "../api";
import { PLATFORM_META } from "../format";
import { fmtCount } from "../format";
import {
  dailyCounts, fmtDelta, handleFromId, postsFigure, staleness, translateError,
  VIEW_WINDOW_LABELS, viewsPartial, viewsReadLabel,
} from "./spyFormat";
import { DailyBars } from "./DailyBars";
import { TopThumbs } from "./TopThumbs";
import { Sparkline } from "./Sparkline";
import { OptionChip } from "./OptionChip";
import { DEFAULT_SPY_CARD_FIELDS, type SpyCardFields } from "./spySettings";
import type { GridDensity } from "../GridDensity";
import { useCountUp } from "../effects";

/** A 7-day loss of at least this share of the followers gets a pulsing dot: an alert, not a button. */
export const SHARP_DROP_SHARE = 0.001;
export function sharpDrop(delta7: number | null | undefined, followers: number | null | undefined): boolean {
  return delta7 != null && followers != null && followers > 0 && delta7 < 0 && -delta7 >= followers * SHARP_DROP_SHARE;
}

interface ProfileCardProps {
  profile: SpyCard;
  onOpen: () => void;
  tagColors?: Record<string, string>;
  fields?: SpyCardFields;
  /** Compact trims padding, the avatar, the big number and the trend so the
      card holds together at the compact grid's narrower minimum. */
  density?: GridDensity;
  /** The reports' tag rule (hub 0.49; [] = every profile): a card outside it says so. */
  reportTags?: string[];
}

export function ProfileCard({
  profile,
  onOpen,
  tagColors,
  fields = DEFAULT_SPY_CARD_FIELDS,
  density = "comfortable",
  reportTags = [],
}: ProfileCardProps) {
  const compact = density === "compact";
  // Out of the reports while the rule is on: none of its tags (hub 0.49).
  const outside = reportTags.length > 0 && !profile.tags.some((t) => reportTags.some((r) => r.toLowerCase() === t.toLowerCase()));
  const meta = PLATFORM_META[profile.platform] ?? {
    label: profile.platform,
    color: "#aeb9cd",
  };

  const st = staleness(profile.lastMeasuredAt);
  const errText = translateError(profile.lastError);
  const isNumericKey = /^\d+$/.test(profile.key);
  // The followers count up to their value when the card arrives (effects.ts).
  const followersShown = useCountUp(profile.latest?.followers);
  const drop = sharpDrop(profile.delta7, profile.latest?.followers);

  const avatarTargetUrl =
    profile.latest?.hasStory && profile.storiesUrl
      ? profile.storiesUrl
      : profile.profileUrl;

  const deltaLines = [
    fields.delta7 && { key: "7", value: profile.delta7, suffix: "em 7 dias" },
    fields.delta30 && { key: "30", value: profile.delta30, suffix: "em 30 dias" },
    fields.deltaTotal && { key: "total", value: profile.deltaTotal, suffix: "total" },
  ].filter(Boolean) as { key: string; value: number | null; suffix: string }[];

  return (
    <article
      onClick={onOpen}
      tabIndex={0}
      aria-label={`Ver detalhes de ${profile.name || profile.key}`}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group relative flex h-full cursor-pointer flex-col rounded-[var(--radius-card)] border bg-card transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-lg hover:shadow-black/20",
        compact ? "p-4" : "p-5"
      )}
    >
      {/* Every section below is a fixed-height slot whose presence depends only
          on the card fields, never on the profile's data: an empty tag list or
          note leaves blank space instead of shifting the rest, so cards in a
          row line up. */}
      <div data-slot="header" className={cn("flex items-center gap-3", compact ? "h-12" : "h-16")}>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <a
            href={avatarTargetUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="relative shrink-0 rounded-full transition-transform hover:scale-105"
            title={profile.latest?.hasStory ? "Ver stories no navegador" : "Ver perfil no navegador"}
            style={{ boxShadow: profile.latest?.hasStory ? `0 0 0 2px ${meta.color}` : undefined }}
          >
            {profile.avatarUrl ? (
              <img
                src={profile.avatarUrl}
                alt=""
                loading="lazy"
                className={cn("rounded-full object-cover", compact ? "h-12 w-12" : "h-16 w-16")}
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className={cn("grid place-items-center rounded-full bg-secondary text-lg font-semibold text-foreground", compact ? "h-12 w-12" : "h-16 w-16")}>
                {(profile.name || profile.key).charAt(0).toUpperCase()}
              </div>
            )}
          </a>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="truncate font-semibold leading-tight text-foreground" title={profile.name || undefined}>
                {profile.name || `@${profile.key}`}
              </span>
              {profile.verified && (
                <BadgeCheck size={14} className="shrink-0 text-primary" aria-label="Verificado" />
              )}
            </div>
            {/* The network pill shares the handle line so the name keeps the width. */}
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none text-[#232833]"
                style={{ background: meta.color }}
              >
                {meta.label}
              </span>
              {profile.name && !isNumericKey && (
                <span className="truncate text-xs text-muted-foreground">@{profile.key}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {(fields.followers || fields.sparkline || deltaLines.length > 0) && (
        <div data-slot="metrics" className={cn("flex items-start justify-between gap-2", compact ? "mt-3" : "mt-4")}>
          <div className="min-w-0 flex-1">
            {fields.followers && (
              <>
                <div className={cn("font-semibold tracking-tight text-foreground", compact ? "h-8 text-2xl leading-8" : "h-9 text-3xl leading-9")}>
                  {profile.latest?.followers != null ? fmtCount(followersShown ?? profile.latest.followers) : "—"}
                </div>
                <div className="h-4 text-xs leading-4 text-muted-foreground">seguidores</div>
              </>
            )}
            {/* Growth lines, or why there is no number yet. */}
            <div className="mt-1.5" style={{ height: `${Math.max(2, deltaLines.length) * 18}px` }}>
              {profile.latest?.followers != null ? (
                deltaLines.map(({ key, value, suffix }) => {
                  const text = fmtDelta(value);
                  return (
                    <div
                      key={key}
                      className={cn(
                        "h-[18px] truncate text-xs font-medium leading-[18px]",
                        text === null || value === 0 ? "text-muted-foreground" : value! > 0 ? "text-good" : "text-danger"
                      )}
                    >
                      {text ?? "—"} {suffix}
                      {key === "7" && drop && <i data-slot="drop" className="fx-pulse" title="Queda brusca em 7 dias" aria-label="Queda brusca em 7 dias" />}
                    </div>
                  );
                })
              ) : !fields.lastMeasured && profile.lastError ? (
                <p className="line-clamp-2 text-xs font-medium leading-[18px] text-amber" title={errText || undefined}>
                  {errText || "falha na medição"}
                </p>
              ) : !profile.lastError ? (
                <p className="line-clamp-2 text-[11px] leading-[18px] text-muted-foreground">
                  Medido uma vez por dia, ou quando você abre o perfil.
                </p>
              ) : null}
            </div>
          </div>

          {fields.sparkline && (
            <div className={cn("mt-1 h-[54px] shrink-0", compact ? "w-[84px]" : "w-28")}>
              {profile.spark && profile.spark.length >= 2 && <Sparkline points={profile.spark} width={compact ? 84 : 112} />}
            </div>
          )}
        </div>
      )}

      {(fields.tags || outside) && (
        <div data-slot="tags" className="mt-3 flex h-11 flex-wrap content-start items-start gap-1 overflow-hidden" title={profile.tags.join(", ") || undefined}>
          {outside && (
            <span data-rule-out className="inline-flex h-5 items-center rounded-full border border-amber/40 px-2 text-[11px] text-amber">
              fora dos relatórios
            </span>
          )}
          {fields.tags && (profile.sameAccountAs ?? []).length > 0 && (
            <span className="inline-flex h-5 items-center rounded-full border border-amber/40 px-2 text-[11px] text-amber">
              mesma conta que {(profile.sameAccountAs ?? []).map(handleFromId).join(", ")}
            </span>
          )}
          {fields.tags && profile.tags.map((tag) => (
            <OptionChip key={tag} value={tag} color={tagColors?.[tag.toLowerCase()]} />
          ))}
        </div>
      )}

      {fields.notes && (
        <p
          data-slot="notes"
          className="mt-2 line-clamp-2 h-[34px] text-[11px] italic leading-[17px] text-muted-foreground"
          title={profile.notes || undefined}
        >
          {profile.notes ? `“${profile.notes}”` : ""}
        </p>
      )}

      {fields.bio && (
        <p data-slot="bio" className="mt-2 line-clamp-2 h-[34px] text-xs leading-[17px] text-muted-foreground/90">
          {profile.bio ?? ""}
        </p>
      )}

      {(fields.posts || fields.following) && (
        <div data-slot="counts" className="mt-2 flex h-[18px] items-center gap-2 text-xs leading-[18px] text-muted-foreground">
          {fields.posts && (() => {
            const posts = postsFigure(profile);
            return (
              <span className="truncate">
                <strong className="font-semibold text-foreground">{posts.value}</strong> {posts.label}
                {posts.counting && " · contando"}
              </span>
            );
          })()}
          {fields.posts && fields.following && <span>•</span>}
          {fields.following && (
            <span>
              <strong className="font-semibold text-foreground">{fmtCount(profile.latest?.following) ?? "—"}</strong> seguindo
            </span>
          )}
        </div>
      )}

      {fields.views && (
        <div
          data-slot="views"
          className="mt-3 grid h-[40px] grid-cols-3 gap-2"
          title={profile.views
            ? `Soma das views dos reels publicados em cada período, ${viewsReadLabel(profile.views.at, profile.views.provisional)}`
            : "Aguardando a primeira leitura das views dos reels"}
        >
          {[0, 1, 2].map((i) => {
            const w = profile.views?.windows[i];
            const label = w ? VIEW_WINDOW_LABELS[w.days] : ["24h", "3 dias", "7 dias"][i];
            return (
              <div key={i} className="min-w-0">
                <div className="h-6 truncate text-lg font-semibold leading-6 tabular-nums text-foreground">
                  {w ? fmtCount(w.views) : "—"}
                </div>
                <div className="h-4 truncate text-[11px] leading-4 text-muted-foreground">
                  {i === 0 ? `views ${label}` : label}{w && viewsPartial(w, profile.views) ? " · parcial" : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {fields.postsDaily && (() => {
        const daily = dailyCounts(profile.daily);
        const fig = (n: number | null) => <strong className="font-semibold text-foreground">{n ?? "—"}</strong>;
        return (
          <div data-slot="daily" className="mt-2 h-[42px]">
            <div className="h-[18px] truncate text-xs leading-[18px] text-muted-foreground">
              {daily.label === "reels" ? "Reels" : "Posts"} ontem {fig(daily.yesterday)} · hoje {fig(daily.today)}
            </div>
            <DailyBars days={daily.days} label={daily.label} className="mt-1 h-5" />
          </div>
        );
      })()}

      {fields.top3 && (
        <div data-slot="top3" className="mt-3 h-[90px]">
          <div className="mb-1 h-4 text-[11px] leading-4 text-muted-foreground">
            Top da semana{profile.top && !profile.top.complete && profile.top.items.length > 0 ? " · parcial" : ""}
          </div>
          <TopThumbs items={profile.top?.items ?? []} />
        </div>
      )}

      {/* Footer: Staleness & Action Buttons */}
      <div data-slot="footer" className="mt-auto flex h-[52px] items-center justify-between gap-2 border-t border-border/50 pt-3 text-xs">
        {fields.lastMeasured ? (
          <span
            className={cn(
              "line-clamp-2 min-w-0",
              profile.lastError && profile.lastMeasuredAt == null
                ? "text-amber font-medium"
                : st.isStale
                ? "text-amber font-medium"
                : "text-muted-foreground"
            )}
            title={errText ? errText : undefined}
          >
            {profile.lastError && profile.lastMeasuredAt == null
              ? (errText || "medição pendente")
              : st.label}
          </span>
        ) : (
          <span />
        )}

        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <a
            href={profile.profileUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Abrir perfil"
          >
            <ExternalLink size={14} />
          </a>

          {profile.storiesUrl && (
            <a
              href={profile.storiesUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title="Abrir stories"
            >
              <CircleDot size={14} />
            </a>
          )}


        </div>
      </div>
    </article>
  );
}
