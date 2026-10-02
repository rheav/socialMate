import { useEffect, useState } from "react";
import { ExternalLink, Trash2 } from "lucide-react";
import { useSpy } from "@/lib/useSpy";
import { dayKey } from "@/lib/spyStore";
import { parseProfileUrl, profileUrl, spyId } from "@/lib/spyProfile";
import { PLATFORMS } from "@/lib/platforms";

const buttonClass = "sw-hoverable rounded-lg border border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50";
function ago(at, now) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}
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
  const { profiles, state, configured, ready, error: loadError, save, remove } = useSpy();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const active = parseProfileUrl(activeUrl);
  const activeId = active ? spyId(active.platform, active.key) : null;
  const saved = profiles.some((p) => p.id === activeId);
  const run = async (id, action) => {
    setBusy(id); setError(null);
    try { await action(); }
    catch (e) {
      setError(e.message === "limit_reached" ? "Limite de 100 perfis. Remova um para salvar outro." : "Não consegui salvar a alteração. Tente de novo.");
    } finally { setBusy(null); }
  };
  const removeProfile = (id) => run(id, () => remove(id));
  const measured = profiles.filter((p) => p.lastMeasuredAt != null && dayKey(p.lastMeasuredAt) === dayKey(now)).length;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-3 space-y-2.5" aria-label="Perfil da aba ativa">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-fg/45">Perfil da aba ativa</h2>
        {active ? <>
          <p className="break-words text-sm font-medium">@{active.key}<span className="text-muted-foreground font-normal"> · {PLATFORMS[active.platform].name}</span></p>
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
            {profiles.map((p) => <li key={p.id} className="flex flex-wrap items-center gap-2 p-3">
              <div className="min-w-0 basis-24 grow">
                <p className="truncate text-sm font-medium" title={p.name || `@${p.key}`}>{p.name || `@${p.key}`}</p>
                <p className="text-[11px] text-muted-foreground">{PLATFORMS[p.platform]?.name}</p>
                <p className="text-[11px] text-muted-foreground">{p.lastMeasuredAt == null ? "aguardando medição" : `medido ${ago(p.lastMeasuredAt, now)}`}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <a href={profileUrl(p.platform, p.key)} target="_blank" rel="noreferrer" className={buttonClass} aria-label={`Abrir perfil @${p.key}`}><ExternalLink className="size-3.5" /></a>
                <RemoveButton id={p.id} remove={removeProfile} disabled={busy != null} />
              </div>
            </li>)}
          </ul>}
      </section>
      <footer className="space-y-2 text-[11px] leading-relaxed text-muted-foreground" aria-live="polite">
        {!configured ? <p>Configure o acervo em Opções para usar a área spy.</p> : <>
          <p>{state.lastPassAt ? `Última passada ${ago(state.lastPassAt, now)}` : "Aguardando a primeira passada"} · {measured} de {profiles.length} medidos</p>
          {["instagram", "facebook"].map((platform) => state.blocked?.[platform] > now &&
            <p key={platform} className="text-amber-600 dark:text-amber-400">{PLATFORMS[platform].name} em pausa até {new Date(state.blocked[platform]).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} — {state.lastError === "login_required" ? "a extensão não está logada nessa rede." : "a rede limitou as consultas."}</p>)}
          {state.lastError === "hub_sem_spy" && <p>Atualize o acervo para usar a área spy.</p>}
        </>}
      </footer>
    </div>
  );
}
