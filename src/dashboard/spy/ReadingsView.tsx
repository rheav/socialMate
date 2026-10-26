import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/dashboard/ui/button";
import { EmptyState } from "@/dashboard/ui/empty-state";
import { Skeleton } from "@/dashboard/ui/skeleton";
import { cn } from "@/dashboard/lib/utils";
import { api, isUnauthorized, type CollectionCheck, type SpyReading } from "../api";
import { PLATFORM_META } from "../format";
import { fmtCount } from "../format";
import { translateError } from "./spyFormat";

const SOURCE_LABEL: Record<SpyReading["source"], string> = {
  daily: "diária",
  visit: "visita",
  manual: "manual",
  initial: "leitura inicial",
  catchup: "continuação",
  refresh: "visualizações da semana",
  pass: "passada",
};

function dayLabel(at: number, now = new Date()): string {
  const d = new Date(at);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Ontem";
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" });
}

function outcome(r: SpyReading): string {
  if (!r.ok) return translateError(r.error) ?? "falhou";
  if (r.kind === "followers") return r.followers != null ? `${fmtCount(r.followers)} seguidores` : "lido";
  if (r.kind === "stories") return r.reelsAdded ? `+${r.reelsAdded} ${r.reelsAdded === 1 ? "story" : "stories"}` : "sem story novo";
  const pages = r.pages ? ` · ${r.pages} ${r.pages === 1 ? "página" : "páginas"}` : "";
  // Instagram reports the Reels tab reading, where the views come from.
  if (r.platform === "instagram") return `views dos reels lidas${pages}`;
  return `+${r.reelsAdded ?? 0} reels${pages}`;
}

const CHECK_STATUS: Record<CollectionCheck["status"], [string, string]> = {
  ok: ["ok", "text-foreground"],
  warn: ["instável", "text-amber"],
  stopped: ["parado", "text-amber"],
  broken: ["quebrado", "text-destructive"],
};

function checkLabel(c: CollectionCheck): string {
  if (c.kind === "video") return "Vídeos das análises";
  if (c.kind === "views") return "Instagram · views em dia, por perfil";
  const kind = c.kind === "reels" && c.platform === "instagram" ? "views dos reels" : c.kind === "followers" ? "seguidores" : c.kind;
  return `${PLATFORM_META[c.platform]?.label ?? c.platform} · ${kind}`;
}

const when = (at: number) => new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Each kind of collection over the last 24 h: a kind that only fails is a breakage to fix in the extension. */
function HealthList({ checks }: { checks: CollectionCheck[] }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Saúde da coleta · últimas 24 h</h3>
      <ul className="divide-y divide-border/60 rounded-[var(--radius-card)] border bg-card">
        {checks.map((c) => {
          const [status, tone] = CHECK_STATUS[c.status];
          return (
            <li key={c.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 basis-48 font-medium text-foreground">{checkLabel(c)}</span>
              <span className={cn("w-16 shrink-0 font-semibold", tone)}>{status}</span>
              <span className="w-28 shrink-0 tabular-nums text-muted-foreground">{c.ok} de {c.attempts} ok</span>
              <span className="w-40 shrink-0 text-muted-foreground">{c.lastOkAt ? `última boa ${when(c.lastOkAt)}` : "nenhuma boa em 7 dias"}</span>
              <span className={cn("min-w-0 basis-48 grow text-right", c.lastError ? "text-amber" : "text-muted-foreground")}>
                {translateError(c.lastError) ?? "sem falhas"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The last days of collection attempts, so a glance confirms the extension is working. */
export function ReadingsView({ health, onUnauthorized }: { health: CollectionCheck[] | null; onUnauthorized: () => void }) {
  const [readings, setReadings] = useState<SpyReading[] | null>(null);
  const [error, setError] = useState(false);
  const [profile, setProfile] = useState("");

  const load = useCallback((signal?: AbortSignal) => {
    setError(false);
    api.spy.readings(3, signal)
      .then((res) => { if (!signal?.aborted) setReadings(res.readings); })
      .catch((err) => {
        if (signal?.aborted) return;
        if (isUnauthorized(err)) onUnauthorized();
        else setError(true);
      });
  }, [onUnauthorized]);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const profiles = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of readings ?? []) if (!seen.has(r.profileId)) seen.set(r.profileId, r.name || `@${r.key}`);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1], "pt-BR"));
  }, [readings]);

  const days = useMemo(() => {
    const groups = new Map<string, SpyReading[]>();
    for (const r of readings ?? []) {
      if (profile && r.profileId !== profile) continue;
      const label = dayLabel(r.at);
      groups.set(label, [...(groups.get(label) ?? []), r]);
    }
    return [...groups];
  }, [readings, profile]);

  return (
    <section aria-label="Histórico de leituras" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Cada tentativa de leitura da extensão nos últimos 3 dias, com sucesso ou falha.
        </p>
        <div className="flex items-center gap-2">
          {profiles.length > 1 && (
            <select
              aria-label="Filtrar por perfil"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              className="h-8 max-w-48 rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              <option value="">Todos os perfis</option>
              {profiles.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          )}
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => load()}>
            <RefreshCw size={13} /> Atualizar
          </Button>
        </div>
      </div>

      {health && health.length > 0 && <HealthList checks={health} />}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          Não consegui carregar as leituras. <button type="button" className="underline" onClick={() => load()}>Tentar novamente</button>
        </p>
      )}

      {readings === null && !error ? (
        <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : readings && days.length === 0 ? (
        <EmptyState
          title="Nenhuma leitura nos últimos 3 dias"
          description="A extensão registra aqui cada leitura de seguidores e de reels. Confira se o Chrome está aberto com a extensão e o acervo configurado."
        />
      ) : (
        days.map(([label, rows]) => {
          const failed = rows.filter((r) => !r.ok).length;
          const share = rows.length ? (rows.length - failed) / rows.length : 1;
          return (
            <div key={label}>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {/* A gauge says from afar how the day went: the share of readings that worked, amber below half. */}
                <svg className={cn("fx-gauge", share < 0.5 && "is-low")} viewBox="0 0 50 50" role="img"
                  aria-label={`${rows.length - failed} de ${rows.length} ok`} style={{ "--off": Math.round(138 * (1 - share)) } as CSSProperties}>
                  <circle className="track" cx="25" cy="25" r="22" />
                  <circle className="val" cx="25" cy="25" r="22" />
                </svg>
                {label}
                <span className="font-normal normal-case tracking-normal">
                  {rows.length} {rows.length === 1 ? "leitura" : "leituras"}
                  {failed > 0 && <span className="text-amber"> · {failed} {failed === 1 ? "falha" : "falhas"}</span>}
                </span>
              </h3>
              <ul className="divide-y divide-border/60 rounded-[var(--radius-card)] border bg-card">
                {rows.map((r, i) => {
                  const meta = PLATFORM_META[r.platform] ?? { label: r.platform, color: "#aeb9cd" };
                  return (
                    <li key={`${r.profileId}|${r.at}|${r.kind}`} className="fx-fade flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs" style={{ "--i": i } as CSSProperties}>
                      <span className="w-11 shrink-0 tabular-nums text-muted-foreground">
                        {new Date(r.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span className="flex min-w-0 flex-1 basis-40 items-center gap-1.5">
                        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none text-[#232833]" style={{ background: meta.color }}>
                          {meta.label}
                        </span>
                        <span className="truncate font-medium text-foreground">{r.name || `@${r.key}`}</span>
                      </span>
                      <span className="w-40 shrink-0 text-muted-foreground">
                        {r.kind === "followers" ? "seguidores" : r.kind === "stories" ? "stories" : "reels"} · {SOURCE_LABEL[r.source] ?? r.source}
                      </span>
                      <span className={cn("min-w-0 basis-48 grow text-right", r.ok ? "text-foreground" : "text-amber")}>
                        {outcome(r)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}
