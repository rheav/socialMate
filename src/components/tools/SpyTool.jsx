import { useEffect, useState } from "react";
import { ExternalLink, Loader2, RotateCw, Trash2 } from "lucide-react";
import { useSpy } from "@/lib/useSpy";
import { dayKey } from "@/lib/spyStore";
import { ago, profileStatus, syncStatus } from "@/lib/spyStatus";
import { parseProfileUrl, profileUrl, spyId } from "@/lib/spyProfile";
import { PLATFORMS } from "@/lib/platforms";

const buttonClass = "sw-hoverable rounded-lg border border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50";
function RemoveButton({ id, remove, disabled = false }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    setConfirm(false);
  }, [id]);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(timer);
  }, [confirm]);
  return (
    <button type="button" disabled={disabled} className={buttonClass}
      aria-label={confirm ? "Confirmar remoção" : "Remover perfil"}
      onClick={() => { if (confirm) { setConfirm(false); remove(id); } else setConfirm(true); }}>
      {confirm ? "confirmar remoção" : <Trash2 className="size-3.5" />}
    </button>
  );
}

export default function SpyTool({ activeUrl = "" }) {
  const { profiles, state, queue, configured, ready, error: loadError, save, remove, measureProfile, runPass } = useSpy();
  const [busy, setBusy] = useState(null);
  const [runningPass, setRunningPass] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const active = parseProfileUrl(activeUrl);
  const activeId = active ? spyId(active.platform, active.key) : null;
  const saved = profiles.find((p) => p.id === activeId);
  const run = async (id, action) => {
    setBusy(id); setError(null);
    try { await action(); }
    catch (e) {
      setError(e.message === "limit_reached" ? "Limite de 100 perfis. Remova um para salvar outro." : "Não consegui salvar a alteração. Tente de novo.");
    } finally { setBusy(null); }
  };
  const removeProfile = (id) => run(id, () => remove(id));
  const measureOne = (id) => run(id, () => measureProfile(id));
  const measured = profiles.filter((p) => p.lastMeasuredAt != null && dayKey(p.lastMeasuredAt) === dayKey(now)).length;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-3 space-y-2.5" aria-label="Perfil da aba ativa">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-fg/45">Perfil da aba ativa</h2>
        {active ? <>
          <p className="break-words text-sm font-medium">
            {saved?.name || (/^\d+$/.test(active.key) ? `Perfil ${active.key}` : `@${active.key}`)}
            <span className="text-muted-foreground font-normal"> · {PLATFORMS[active.platform].name}</span>
          </p>
          {saved ? <RemoveButton key={activeId} id={activeId} remove={removeProfile} disabled={busy != null} /> :
            <button type="button" className={buttonClass} disabled={!configured || busy != null}
              onClick={() => run(activeId, () => save(active.platform, active.key))}>
              {busy === activeId ? "salvando…" : "Salvar perfil"}
            </button>}
        </> : <p className="text-xs leading-relaxed text-muted-foreground">Abra um perfil do Instagram ou do Facebook para salvá-lo.</p>}
      </section>

      {(error || (configured && loadError)) && <p role="alert" className="text-xs text-destructive">{error || loadError}</p>}
      <section aria-label="Perfis salvos" className="space-y-2">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-fg/45">Perfis salvos</h2>
        {!ready ? <p className="text-xs text-muted-foreground">Carregando perfis…</p> : !profiles.length ?
          <p className="text-xs text-muted-foreground">Nenhum perfil salvo.</p> :
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {profiles.map((p) => {
              const isNumeric = /^\d+$/.test(p.key);
              const displayName = p.name || (isNumeric ? `Perfil ${p.key}` : `@${p.key}`);
              const subtitle = p.name
                ? `${PLATFORMS[p.platform]?.name || p.platform}${!isNumeric ? ` · @${p.key}` : ""}`
                : (PLATFORMS[p.platform]?.name || p.platform);
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-2 p-3">
                  <div className="min-w-0 basis-24 grow">
                    <p className="truncate text-sm font-medium" title={displayName}>{displayName}</p>
                    <p className="text-[11px] text-muted-foreground">{subtitle}</p>
                    {(() => {
                      const status = profileStatus(p, { state, queue, now });
                      const tone = status.kind === "measuring" ? "font-medium text-primary"
                        : status.kind === "failed" || status.kind === "paused" ? "text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground";
                      return (
                        <p className={`text-[11px] flex items-center gap-1 ${tone}`}>
                          {status.kind === "measuring" && <Loader2 className="size-3 animate-spin shrink-0" />}
                          {status.kind === "pending" && <span className="inline-block size-1.5 rounded-full bg-primary/70 animate-pulse" />}
                          {status.text}
                        </p>
                      );
                    })()}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {p.platform === "facebook" && <button
                      type="button"
                      disabled={busy != null || !!state.measuring}
                      className={buttonClass}
                      onClick={() => measureOne(p.id)}
                      title="Medir este perfil agora"
                      aria-label={p.name ? `Medir ${p.name}` : `Medir perfil @${p.key}`}
                    >
                      <RotateCw className={`size-3.5 ${busy === p.id || state.measuring?.id === p.id ? "animate-spin" : ""}`} />
                    </button>}
                    <a href={profileUrl(p.platform, p.key)} target="_blank" rel="noreferrer" className={buttonClass}
                      title={p.platform === "instagram" ? "Abrir perfil para medir pela captura passiva" : "Abrir perfil"}
                      aria-label={`Abrir ${p.name || `perfil @${p.key}`}${p.platform === "instagram" ? " para medir" : ""}`}><ExternalLink className="size-3.5" /></a>
                    <RemoveButton id={p.id} remove={removeProfile} disabled={busy != null} />
                  </div>
                </li>
              );
            })}
          </ul>}
      </section>
      <footer className="space-y-2 text-[11px] leading-relaxed text-muted-foreground" aria-live="polite">
        {!configured ? <p>Configure o acervo em Opções para usar a área spy.</p> : <>
          {state.measuring ? (
            <p className="text-primary font-medium flex items-center gap-1.5 py-1">
              <Loader2 className="size-3.5 animate-spin shrink-0" />
              Medindo {(() => {
                const activeP = profiles.find((p) => p.id === state.measuring.id);
                const isNum = /^\d+$/.test(state.measuring.key);
                return activeP?.name || (isNum ? `perfil ${state.measuring.key}` : `@${state.measuring.key}`);
              })()} ({PLATFORMS[state.measuring.platform]?.name || state.measuring.platform})…
            </p>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div>
                <p>
                  {state.lastPassAt ? `Última passada ${ago(state.lastPassAt, now)}` : "Aguardando primeira passada"} · {measured} de {profiles.length} medidos
                </p>
                {(() => {
                  const sync = syncStatus(queue, state);
                  return <p className={state.lastError === "limit_reached" ? "text-amber-600 dark:text-amber-400" : undefined}>{sync.text}</p>;
                })()}
              </div>
              {profiles.length > 0 && (
                <button
                  type="button"
                  disabled={runningPass || busy != null || !!state.measuring}
                  className={buttonClass}
                  onClick={async () => {
                    setRunningPass(true);
                    try {
                      await runPass();
                    } catch {
                      setError("Não consegui iniciar a medição.");
                    } finally {
                      setRunningPass(false);
                    }
                  }}
                  title="Executar medição agora"
                >
                  {runningPass ? "iniciando…" : "Medir agora"}
                </button>
              )}
            </div>
          )}
          {["instagram", "facebook"].map((platform) => state.blocked?.[platform] > now &&
            <p key={platform} className="text-amber-600 dark:text-amber-400">{PLATFORMS[platform].name} em pausa até {new Date(state.blocked[platform]).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} — {state.lastError === "login_required" ? "a extensão não está logada nessa rede." : "a rede limitou as consultas."}</p>)}
          {state.lastError === "hub_sem_spy" && <p>Atualize o acervo para usar a área spy.</p>}
        </>}
      </footer>
    </div>
  );
}
