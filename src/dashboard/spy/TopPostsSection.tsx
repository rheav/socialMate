import { Clock, Eye, Heart, MessageCircle, Play, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Segmented } from "@/dashboard/ui/segmented";
import { Skeleton } from "@/dashboard/ui/skeleton";
import { cn } from "@/dashboard/lib/utils";
import { api, isUnauthorized, type SpyTopPost, type SpyTopPosts } from "../api";
import { useCountUp } from "../effects";
import type { PostRanking } from "../../hub-local/shared/spy-metrics";
import { fmtCount } from "../format";

// Top posts of the gallery: the five most viewed Instagram videos of the saved
// profiles per period, and the median views per weekday and hour of posting.
// Days and hours are in this computer's time zone, like the local database's.

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PERIODS = [
  { key: "1", label: "Ontem", empty: "Nenhum vídeo postado ontem." },
  { key: "3", label: "3 dias", empty: "Nenhum vídeo postado nos últimos 3 dias." },
  { key: "7", label: "7 dias", empty: "Nenhum vídeo postado nos últimos 7 dias." },
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];
const DAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const HEAT = ["var(--heat-1)", "var(--heat-2)", "var(--heat-3)", "var(--heat-4)"];
/** The hours with the highest medians get a glow and a "top horário" label. */
const TOP_HOURS = 5;
const GLOW = "0 0 0 1.5px var(--color-amber), 0 0 10px 2px color-mix(in srgb, var(--color-amber) 55%, transparent)";

const posted = (s: number) => {
  const d = new Date(s * 1000);
  const day = d.toLocaleDateString("pt-BR", { timeZone: ZONE, weekday: "short", day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("pt-BR", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" });
  return `${day.replace(/\.,?/g, "")} · ${time}`;
};
const views = (n: number) => `${fmtCount(n)} ${n === 1 ? "view" : "views"}`;
const videos = (n: number) => `${n} ${n === 1 ? "vídeo" : "vídeos"}`;
const hourSpan = (h: number) => `${h}h–${h + 1}h`;

const number = (n: number | null | undefined) => n == null ? "—" : n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const durationLabel = (n: number | null | undefined) => {
  if (n == null) return "—";
  const seconds = Math.round(n);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
};

function PostCard({ post, rank }: { post: SpyTopPost; rank: number }) {
  // The views count up to their value when the card arrives (effects.ts).
  const views = useCountUp(post.views);
  return (
    <div className="relative h-full">
    <a
      href={post.url}
      target="_blank"
      rel="noreferrer"
      className="group/post flex min-w-0 gap-3 rounded-lg border bg-card/60 p-2 transition-colors hover:bg-secondary/60"
    >
      <span className="relative block aspect-[9/16] w-14 shrink-0 overflow-hidden rounded-md bg-secondary">
        {post.thumbUrl ? (
          <img src={post.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover/post:scale-105" />
        ) : (
          <span className="grid h-full w-full place-items-center text-muted-foreground/60"><Play size={14} /></span>
        )}
        <span className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-[10px] font-bold text-white">{rank}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-between gap-1 py-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {post.avatarUrl ? (
            <img src={post.avatarUrl} alt="" loading="lazy" className="h-5 w-5 shrink-0 rounded-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary text-[10px] font-semibold text-foreground">
              {(post.name || post.key).charAt(0).toUpperCase()}
            </span>
          )}
          <span className="truncate text-xs text-foreground">@{post.key}</span>
        </span>
        <span className="flex items-center gap-1 text-sm font-semibold tabular-nums text-foreground">
          <Eye size={13} className="shrink-0 text-muted-foreground" /> {fmtCount(views ?? post.views)}
        </span>
        <span className="flex items-center gap-2.5 text-[11px] tabular-nums text-muted-foreground">
          {post.likes != null && <span className="flex items-center gap-1"><Heart size={11} /> {fmtCount(post.likes)}</span>}
          {post.comments != null && <span className="flex items-center gap-1"><MessageCircle size={11} /> {fmtCount(post.comments)}</span>}
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums">
          <span title="100 × (curtidas + comentários) ÷ views. Conta ações, não pessoas únicas.">Interação <strong>{number(post.engagementRate)}{post.engagementRate != null ? "%" : ""}</strong></span>
          <span title="100 × (curtidas + 4 × comentários) ÷ views. Sem reposts; não é porcentagem de pessoas.">Índice <strong>{number(post.weightedIndex)}</strong></span>
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground" title="Comentários ÷ views × 1.000">{number(post.commentsPer1000)} comentários / mil views</span>
        {post.relativeViews != null && <span className="text-[11px] text-foreground" title={`Views ÷ mediana de ${post.baselinePosts} outros vídeos do perfil publicados nos 90 dias anteriores. Últimos contadores disponíveis, sem ajuste por idade.`}>{number(post.relativeViews)}× a mediana do perfil</span>}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>{posted(post.createdAt)}</span>
          {post.durationS != null && <span className="inline-flex items-center gap-1"><Clock size={10} />{durationLabel(post.durationS)}</span>}
        </span>
        {post.views < 1000 && <span className="text-[10px] text-muted-foreground">Menos de 1.000 views</span>}
        {post.metricsAt != null && <span className="text-[10px] text-muted-foreground" title="Momento da última observação disponível; os contadores podem ter sido lidos em momentos diferentes.">Observado em {posted(post.metricsAt / 1000)}</span>}
      </span>
    </a>
    </div>
  );
}

/** Four steps on a log scale between the smallest and the largest median: views span orders of magnitude. */
function heatStep(median: number, min: number, max: number): number {
  if (max <= min) return HEAT.length - 1;
  const t = (Math.log(Math.max(median, 1)) - Math.log(Math.max(min, 1))) / (Math.log(max) - Math.log(Math.max(min, 1)));
  return Math.min(HEAT.length - 1, Math.floor(t * HEAT.length));
}

function HoursMap({ hours }: { hours: SpyTopPosts["hours"] }) {
  const [hovered, setHovered] = useState<{ day: number; hour: number } | null>(null);
  const byCell = new Map(hours.cells.map((c) => [c.day * 24 + c.hour, c]));
  const medians = hours.cells.map((c) => c.median);
  const min = Math.min(...medians);
  const max = Math.max(...medians);
  const active = hovered ? byCell.get(hovered.day * 24 + hovered.hour) : null;
  const tops = new Set([...hours.cells].sort((a, b) => b.median - a.median || b.videos - a.videos)
    .slice(0, TOP_HOURS).map((c) => c.day * 24 + c.hour));
  const isTop = (day: number, hour: number) => tops.has(day * 24 + hour);

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Horários de postagem</div>
        <div className="text-[11px] text-muted-foreground">
          Mediana das views por dia e hora · últimos 90 dias · fuso deste computador · {videos(hours.videos)}
        </div>
      </div>
      <p className="mb-2 h-4 truncate text-xs text-foreground" aria-live="polite">
        {hovered ? (
          active ? (
            <><strong className="font-semibold tabular-nums">{views(active.median)}</strong>
              <span className="text-muted-foreground"> de mediana · {DAYS[hovered.day]} {hourSpan(hovered.hour)} · {videos(active.videos)}</span>
              {isTop(hovered.day, hovered.hour) && <span className="text-amber"> · top horário</span>}</>
          ) : (
            <span className="text-muted-foreground">{DAYS[hovered.day]} {hourSpan(hovered.hour)} · nenhum vídeo</span>
          )
        ) : (
          <span className="text-muted-foreground">Passe o mouse numa célula para ver os números.</span>
        )}
      </p>
      {hours.cells.length === 0 ? (
        <p className="text-xs text-muted-foreground">Os horários aparecem quando houver vídeos lidos nos últimos 90 dias.</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[34rem] table-fixed border-separate border-spacing-[2px]" onMouseLeave={() => setHovered(null)}>
            <caption className="sr-only">Mediana das views dos vídeos por dia da semana e hora de postagem, no fuso deste computador</caption>
            <thead>
              <tr>
                <th className="w-9" />
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} scope="col" className="text-left text-[10px] font-normal tabular-nums text-muted-foreground">
                    {h}h
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DAYS.map((name, day) => (
                <tr key={name}>
                  <th scope="row" className="pr-1 text-left text-[11px] font-normal text-muted-foreground">{name}</th>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const cell = byCell.get(day * 24 + hour);
                    const on = hovered?.day === day && hovered.hour === hour;
                    const top = isTop(day, hour);
                    return (
                      <td
                        key={hour}
                        aria-label={`${name} ${hourSpan(hour)}: ${cell ? `${views(cell.median)} de mediana, ${videos(cell.videos)}${top ? ", top horário" : ""}` : "nenhum vídeo"}`}
                        onMouseEnter={() => setHovered({ day, hour })}
                        className={cn("h-5 rounded-[3px] p-0", !cell && "bg-secondary/40", top && "relative z-10", on && "outline outline-2 outline-foreground/70")}
                        style={cell ? { background: HEAT[heatStep(cell.median, min, max)], boxShadow: top ? GLOW : undefined } : undefined}
                      >
                        {top && (
                          // A narrow cell (phone) only fits "top".
                          <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden whitespace-nowrap text-[9px] font-semibold leading-none text-primary-foreground @container">
                            <span className="hidden @min-[3.6rem]:inline">top horário</span>
                            <span className="@min-[3.6rem]:hidden">top</span>
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              menos views
              {HEAT.map((color) => <span key={color} className="h-3 w-4 rounded-[3px]" style={{ background: color }} />)}
              mais views
            </span>
            <span className="flex items-center gap-1.5"><span className="h-3 w-4 rounded-[3px] bg-secondary/40" /> nenhum vídeo</span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-4 rounded-[3px]" style={{ background: HEAT[HEAT.length - 1], boxShadow: GLOW }} /> top horário: as {TOP_HOURS} maiores medianas
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Gallery section: the top posts per period and the hours map. `refreshKey` changes when a new reading lands. */
export function TopPostsSection({ refreshKey, onUnauthorized, onOpenSettings }: { refreshKey: string; onUnauthorized: () => void; onOpenSettings?: () => void }) {
  const [data, setData] = useState<SpyTopPosts | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [ranking, setRanking] = useState<PostRanking>("views");
  const [period, setPeriod] = useState<PeriodKey>("1");

  useEffect(() => {
    const ac = new AbortController();
    setFailed(false);
    api.spy.top(ac.signal, ranking)
      .then((res) => { if (!ac.signal.aborted) setData(res); })
      .catch((err) => {
        if (ac.signal.aborted) return;
        if (isUnauthorized(err)) onUnauthorized();
        else setFailed(true);
      });
    return () => ac.abort();
  }, [refreshKey, retry, onUnauthorized, ranking]);

  const current = PERIODS.find((p) => p.key === period)!;
  const window = data?.windows.find((w) => String(w.days) === period);
  const items = window?.items ?? [];

  return (
    <section className="space-y-4 rounded-xl border bg-card/40 p-4" aria-labelledby="spy-top-posts">
      {/* One line: what it is, which period, which order, and the Top's mean duration. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="spy-top-posts" className="text-sm font-semibold text-foreground">Top posts</h2>
        <Segmented value={period} options={PERIODS.map(({ key, label }) => ({ key, label }))} onChange={setPeriod} />
        <select aria-label="Ordenar Top posts" value={ranking}
          onChange={(event) => { setData(null); setRanking(event.target.value as PostRanking); }}
          className="h-8 rounded-md border bg-background px-2 text-xs text-foreground">
          <option value="views">Mais vistos</option>
          <option value="engagement">Maior interação / view</option>
          <option value="comments">Mais comentários / mil views</option>
        </select>
        {/* A tag rule on what the Top reads (none in this build: every profile is read). */}
        {data?.profiles && data.profiles.tags.length > 0 && (
          <span className="inline-flex h-6 items-center gap-2 rounded-full border border-good/45 px-2.5 text-[11.5px] font-semibold text-good">
            <span data-rule-badge>
              só {data.profiles.tags.join(" + ")} · {data.profiles.read} de {data.profiles.total} {data.profiles.total === 1 ? "perfil" : "perfis"}
            </span>
            {onOpenSettings && (
              <button type="button" onClick={onOpenSettings} className="inline-flex cursor-pointer items-center gap-1 font-medium text-muted-foreground transition-colors hover:text-foreground">
                <Settings2 size={11} aria-hidden />
                mudar
              </button>
            )}
          </span>
        )}
        {items.length > 0 && (
          <span className="ml-auto flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
            <span className="text-foreground">Duração média <strong className="ml-0.5 text-sm tabular-nums">{durationLabel(window?.duration?.mean)}</strong></span>
            <span>· mediana {durationLabel(window?.duration?.median)}</span>
            <span>· {window?.duration?.known ?? 0} de {items.length} com duração</span>
            {!window?.duration?.known && <span>· aguardando a extensão ler a duração</span>}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          Vídeos publicados no período · dias fechados no fuso deste computador · últimos contadores disponíveis.
          {ranking !== "views" && " Ranking com pelo menos 1.000 views e a métrica disponível."}
        </span>
        <details className="open:basis-full">
          <summary className="cursor-pointer">Como ler as métricas</summary>
          <p className="mt-1">Interação = (curtidas + comentários) ÷ views × 100. Índice = (curtidas + 4 × comentários) ÷ views × 100, sem reposts. Contam ações, não pessoas únicas. A comparação com o perfil usa pelo menos 5 outros vídeos anteriores e não ajusta a idade dos posts.</p>
        </details>
      </div>

      {failed && !data ? (
        <p role="alert" className="text-xs text-destructive">
          Não consegui carregar os top posts. <button type="button" className="underline" onClick={() => setRetry((n) => n + 1)}>Tentar novamente</button>
        </p>
      ) : !data ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[116px] rounded-lg" />)}
        </div>
      ) : (
        <>
          {items.length ? (
            <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" aria-label={`Top posts · ${current.label}`}>
              {items.map((post, i) => (
                <li key={post.id} className="fx-fade min-w-0" style={{ "--i": i } as React.CSSProperties}><PostCard post={post} rank={i + 1} /></li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">{ranking === "views" ? current.empty : "Nenhum vídeo com pelo menos 1.000 views e a métrica disponível neste período."}</p>
          )}
          <HoursMap hours={data.hours} />
        </>
      )}
    </section>
  );
}
