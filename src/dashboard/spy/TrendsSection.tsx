import { RotateCcw, TrendingDown, TrendingUp, Zap } from "lucide-react";
import { cn } from "@/dashboard/lib/utils";
import {
  BASE_WEEKS, ER_HALF_LIFE_DAYS, ER_WINDOW_DAYS, GAP_DAYS, MATURE_S, SPIKE, SPIKE_AFTER_DAYS, SPIKE_BASE_DAYS, STEP_DOWN, STEP_UP,
  type ProfileTrends, type TrendEvent, type VphBucket,
} from "../../hub-local/shared/spy-trends";
import { RATE_MIN_VIEWS } from "../../hub-local/shared/spy-metrics";
import { fmtCount } from "../format";

const heading = "mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground";
/** Events older than this stay out of the sheet. */
const EVENTS_DAYS = 60;
const EVENTS_MAX = 5;
const BUCKET_LABELS: Record<VphBucket["key"], string> = { "1d": "Até 24 h", "3d": "1 a 3 dias", "7d": "3 a 7 dias", "30d": "7 a 30 dias" };

const date = (s: number) => new Date(s * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const times = (r: number) => `${r.toFixed(r < 10 ? 1 : 0).replace(".", ",")}×`;
const pct = (n: number) => `${n.toFixed(1).replace(".", ",")}%`;
const perHour = (n: number) => `${fmtCount(Math.round(n))}/h`;
const age = (h: number) => (h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} dias`);

function eventText(e: TrendEvent): { icon: typeof Zap; tone: string; title: string; detail: string } {
  switch (e.kind) {
    case "step_up":
      return { icon: TrendingUp, tone: "text-good", title: "As views subiram de patamar",
        detail: `semana de ${date(e.at)}: mediana ${times(e.ratio!)} a das ${BASE_WEEKS} semanas antes` };
    case "step_down":
      return { icon: TrendingDown, tone: "text-danger", title: "As views caíram de patamar",
        detail: `semana de ${date(e.at)}: mediana em ${pct(100 * e.ratio!)} da das ${BASE_WEEKS} semanas antes` };
    case "spike":
      return { icon: Zap, tone: "text-amber", title: "Pico que voltou ao normal",
        detail: `reel de ${date(e.at)} com ${times(e.ratio!)} a mediana dos ${SPIKE_BASE_DAYS} dias antes; os seguintes voltaram ao normal` };
    case "comeback":
      return { icon: RotateCcw, tone: "text-sky", title: `Voltou a postar depois de ${e.gapDays} dias parado`,
        detail: `primeiro post em ${date(e.at)}` };
  }
}

/** Profile sheet: level changes, spikes, returns, views per hour by age and the interaction rate. */
export function TrendsSection({ trends, nowMs = Date.now() }: { trends: ProfileTrends | null | undefined; nowMs?: number }) {
  if (!trends) return null;
  const events = trends.events.filter((e) => e.at * 1000 >= nowMs - EVENTS_DAYS * 86_400_000);
  const shown = events.slice(0, EVENTS_MAX);
  const { buckets, latest } = trends.vph;
  const hasVph = buckets.some((b) => b.posts > 0);
  const er = trends.engagement;

  return (
    <div>
      <div className={heading}>Sinais do perfil</div>
      <div className="space-y-4 rounded-xl border bg-card/40 p-3">
        <div>
          {!shown.length ? (
            <p className="text-xs text-muted-foreground">Nenhuma mudança de patamar, pico ou volta depois de pausa nos últimos {EVENTS_DAYS} dias.</p>
          ) : (
            <ul className="divide-y divide-border/40">
              {shown.map((e) => {
                const t = eventText(e);
                const Icon = t.icon;
                return (
                  <li key={`${e.kind}-${e.at}`} className="flex gap-2.5 py-2 first:pt-0 last:pb-0">
                    <Icon size={14} className={cn("mt-0.5 shrink-0", t.tone)} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-foreground">{t.title}</div>
                      <div className="text-[11px] text-muted-foreground">{t.detail}</div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                        {e.posts.map((p) => (
                          <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="text-[11px] text-primary underline-offset-2 hover:underline">
                            {e.kind === "comeback" || p.views == null ? `post de ${date(p.createdAt)}` : `${fmtCount(p.views)} views · ${date(p.createdAt)}`}
                          </a>
                        ))}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {events.length > shown.length && (
            <p className="mt-2 text-[11px] text-muted-foreground">e mais {events.length - shown.length} nos últimos {EVENTS_DAYS} dias.</p>
          )}
        </div>

        {hasVph && (
          <div className="border-t border-border/40 pt-3">
            <div className="mb-1.5 text-[11px] font-medium text-foreground">Views por hora, pela idade do reel</div>
            <div className="grid grid-cols-4 gap-2">
              {buckets.map((b) => (
                <div key={b.key} className={cn("min-w-0 rounded-lg border bg-card/60 px-2 py-1.5", latest?.bucket === b.key && "border-primary/60")}>
                  <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{BUCKET_LABELS[b.key]}</div>
                  <div className="truncate text-sm font-semibold tabular-nums text-foreground">{b.median != null ? perHour(b.median) : "—"}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{b.posts} {b.posts === 1 ? "reel" : "reels"}</div>
                </div>
              ))}
            </div>
            {latest && (
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                <a href={latest.url} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">Reel mais novo</a>
                {" "}(lido com {age(latest.ageH)}): <span className="font-medium text-foreground">{perHour(latest.vph)}</span>
                {latest.ratio != null
                  ? <>, <span className={cn("font-medium", latest.ratio >= 1 ? "text-good" : "text-danger")}>{times(latest.ratio)}</span> o normal do perfil nessa idade.</>
                  : ", ainda sem reels suficientes nessa idade para comparar."}
              </p>
            )}
          </div>
        )}

        {er && (
          <div className="border-t border-border/40 pt-3 text-[11px] text-muted-foreground">
            <div className="mb-1.5 text-[11px] font-medium text-foreground">Taxa de interação</div>
            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0 rounded-lg border bg-card/60 px-2 py-1.5">
                <div className="truncate text-[10px] uppercase tracking-wide">Média, {ER_WINDOW_DAYS} dias</div>
                <div className="text-sm font-semibold tabular-nums text-foreground">{pct(er.plain)}</div>
              </div>
              <div className="min-w-0 rounded-lg border bg-card/60 px-2 py-1.5">
                <div className="truncate text-[10px] uppercase tracking-wide">Peso nos recentes</div>
                <div className={cn("text-sm font-semibold tabular-nums", er.weighted > er.plain ? "text-good" : er.weighted < er.plain ? "text-danger" : "text-foreground")}>{pct(er.weighted)}</div>
              </div>
            </div>
            <p className="mt-2 leading-relaxed">
              (curtidas + comentários) ÷ views de {er.posts} {er.posts === 1 ? "reel" : "reels"} com {RATE_MIN_VIEWS.toLocaleString("pt-BR")} views ou mais. No peso nos recentes, um reel de {ER_HALF_LIFE_DAYS} dias conta metade de um de hoje.
            </p>
          </div>
        )}

        <p className="border-t border-border/40 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          Patamar: a mediana de views de uma semana contra as {BASE_WEEKS} semanas antes ({times(STEP_UP)} para cima ou {pct(100 * STEP_DOWN)} para baixo), confirmada pela semana seguinte.
          Pico: um reel com {SPIKE}× a mediana dos {SPIKE_BASE_DAYS} dias antes, e os dos {SPIKE_AFTER_DAYS} dias seguintes de volta ao normal.
          Só entram reels lidos com {MATURE_S / 86_400} dias ou mais. Volta: {GAP_DAYS} dias ou mais sem post.
        </p>
      </div>
    </div>
  );
}
