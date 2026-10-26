import { Eye, Play } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { cn } from "@/dashboard/lib/utils";
import { api, isUnauthorized, type SpyCard, type SpyViewsDetail } from "../api";
import { fmtCount } from "../format";
import { DailyBars } from "./DailyBars";
import { TrendsSection } from "./TrendsSection";
import {
  ageLabel, VIEW_WINDOW_LABELS, viewsPartial, viewsPerDay, viewsReadLabel, windowReels,
} from "./spyFormat";

// Recharts is the bulk of the dashboard bundle and only this drawer draws it.
const ViewsChart = lazy(() => import("./ViewsChart").then((m) => ({ default: m.ViewsChart })));

const heading = "mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground";
const dayName = (d: Date) => d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
const published = (s: number) =>
  new Date(s * 1000).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Profile sheet: the views of the reels per period, the reels behind each sum, per day and over time. */
export function ViewsSection({ profile, onUnauthorized }: { profile: SpyCard; onUnauthorized: () => void }) {
  const [detail, setDetail] = useState<SpyViewsDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(0);
  const block = detail?.block ?? profile.views ?? null;

  // A new reading (views.at) brings new numbers: load again.
  useEffect(() => {
    const ac = new AbortController();
    setFailed(false);
    api.spy.views(profile.id, ac.signal)
      .then((res) => { if (!ac.signal.aborted) setDetail(res); })
      .catch((err) => {
        if (ac.signal.aborted) return;
        if (isUnauthorized(err)) onUnauthorized();
        else setFailed(true);
      });
    return () => ac.abort();
  }, [profile.id, profile.views?.at, onUnauthorized, retry]);

  const active = block?.windows[selected] ?? null;
  const list = block && detail ? windowReels(detail.reels, block.at, active?.days ?? 1) : [];
  const days = viewsPerDay(detail?.reels ?? [], profile.daily?.since ?? null);

  return (
    <>
      <div>
        <div className={heading}>
          Views dos reels{block ? <span className="font-normal normal-case tracking-normal"> · {viewsReadLabel(block.at, block.provisional)}</span> : null}
        </div>
        {failed && (
          <p role="alert" className="mb-2 text-xs text-destructive">
            Não consegui carregar as views. <button type="button" className="underline" onClick={() => setRetry((n) => n + 1)}>Tentar novamente</button>
          </p>
        )}
        <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Período das views">
          {[0, 1, 2].map((i) => {
            const w = block?.windows[i];
            const label = w ? VIEW_WINDOW_LABELS[w.days] : ["24h", "3 dias", "7 dias"][i];
            return (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={selected === i}
                onClick={() => setSelected(i)}
                className={cn(
                  "min-w-0 cursor-pointer rounded-lg border bg-card/60 px-3 py-2 text-left transition-colors hover:bg-secondary/60",
                  selected === i && "border-primary/60 bg-primary/10",
                )}
              >
                <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                  {label}{w && viewsPartial(w, block) ? " · parcial" : ""}
                </div>
                <div className="truncate text-base font-semibold tabular-nums text-foreground">{w ? fmtCount(w.views) : "—"}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {w ? `${w.reels} ${w.reels === 1 ? "reel" : "reels"}` : "sem leitura"}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-2 rounded-xl border bg-card/40 p-3" role="tabpanel">
          {!block ? (
            <p className="text-xs text-muted-foreground">As views aparecem depois da primeira leitura dos reels do perfil.</p>
          ) : !list.length ? (
            <p className="text-xs text-muted-foreground">Nenhum reel publicado nas {VIEW_WINDOW_LABELS[active?.days ?? 1]} antes da leitura.</p>
          ) : (
            <ul className="divide-y divide-border/40">
              {list.map((reel) => (
                <li key={reel.id}>
                  <a
                    href={reel.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 rounded-md py-1.5 transition-colors hover:bg-secondary/50"
                  >
                    <span className="block aspect-[9/16] w-9 shrink-0 overflow-hidden rounded bg-secondary">
                      {reel.thumbUrl ? (
                        <img src={reel.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <span className="grid h-full w-full place-items-center text-muted-foreground/60"><Play size={12} /></span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-foreground">{ageLabel(reel.createdAt)}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{published(reel.createdAt)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-xs font-semibold tabular-nums text-foreground">
                      {reel.views != null ? <><Eye size={12} className="text-muted-foreground" /> {fmtCount(reel.views)}</> : <span className="font-normal text-muted-foreground">sem views</span>}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <div className={heading}>Views por dia de publicação</div>
        <div className="rounded-xl border bg-card/40 p-3">
          <DailyBars days={days} label="views" format={(n) => fmtCount(n) ?? String(n)} className="h-10" />
          <table className="mt-3 w-full text-xs">
            <tbody>
              {days.map((d, i) => (
                <tr key={d.key} className="border-t border-border/40 first:border-t-0">
                  <td className="py-1 text-muted-foreground">{i === 0 ? "Hoje" : i === 1 ? "Ontem" : dayName(d.start)}</td>
                  <td className="py-1 text-right tabular-nums font-medium text-foreground">{d.count == null ? "—" : fmtCount(d.count)}</td>
                  <td className="w-32 py-1 pl-3 text-right text-[11px] text-muted-foreground">
                    {d.count == null ? "sem dados" : `${d.reels} ${d.reels === 1 ? "reel" : "reels"}${d.partial ? " · parcial" : ""}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border bg-card/40 p-4">
        <div className={heading}>Histórico das views</div>
        <Suspense fallback={<div className="h-[220px] w-full rounded-xl border bg-card/40" />}>
          <ViewsChart history={detail?.history ?? []} />
        </Suspense>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Soma das views dos reels publicados nas 24 h, 3 e 7 dias antes de cada leitura (uma vez por dia, na visita ao
          perfil ou em Medir agora), com as views lidas naquela hora. Reels que saem depois da leitura entram na próxima.
          {profile.platform === "facebook"
            ? " O Facebook mostra alguns números abreviados."
            : " No Instagram, só vídeos têm views; fotos e carrosséis ficam fora."}
          {" "}Um dia com reel sem views, ou antes do começo do registro, aparece como parcial.
        </p>
      </div>

      <TrendsSection trends={detail?.trends} />
    </>
  );
}
