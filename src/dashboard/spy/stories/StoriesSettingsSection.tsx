import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/dashboard/ui/button";
import { Input } from "@/dashboard/ui/input";

import { api, isUnauthorized, type SpySettings } from "../../api";

// The stories' settings (gear → Stories): how many passes a day the extension
// makes and for how many days a story stays. They live in the local database,
// unlike the card fields.

const PASSES = [1, 2, 3, 4];

export function StoriesSettingsSection({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [settings, setSettings] = useState<SpySettings | null>(null);
  const [passes, setPasses] = useState<number | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  useEffect(() => {
    api.spy.settings.get().then(setSettings).catch((err) => { if (isUnauthorized(err)) onUnauthorized(); else setState("failed"); });
  }, [onUnauthorized]);
  // The saved values fill the fields once; what is typed afterwards stays.
  useEffect(() => {
    if (!settings) return;
    setPasses((v) => v ?? settings.stories.passesPerDay);
    setDays((v) => v ?? String(settings.stories.keepDays));
  }, [settings]);

  if (!settings || passes == null || days == null) {
    return <p className="text-xs text-muted-foreground">{state === "failed" ? "Não consegui carregar as configurações." : "Carregando…"}</p>;
  }

  const keepDays = Number(days);
  const daysInvalid = !Number.isInteger(keepDays) || keepDays < 1 || keepDays > 30;
  const changed = passes !== settings.stories.passesPerDay || keepDays !== settings.stories.keepDays;
  const mb = Math.round(settings.usage.bytes / 1e6).toLocaleString("pt-BR");
  const starredMb = Math.round(settings.usage.starredBytes / 1e6).toLocaleString("pt-BR");

  async function save(e: FormEvent) {
    e.preventDefault();
    if (daysInvalid || !changed || passes == null) return;
    setState("saving");
    try {
      setSettings(await api.spy.settings.patch({ stories: { passesPerDay: passes, keepDays } }));
      setState("saved");
    } catch (err) {
      if (isUnauthorized(err)) onUnauthorized();
      else setState("failed");
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Stories</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          A extensão passa nas contas com “Trackear stories” ligado e guarda cada story inteiro, sem marcar como visto.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Passadas por dia</span>
          <select
            aria-label="Passadas por dia"
            value={passes}
            onChange={(e) => { setPasses(Number(e.target.value)); setState("idle"); }}
            className="block h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground"
          >
            {PASSES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Guardar por (dias)</span>
          <Input type="number" min={1} max={30} step={1} required value={days} aria-label="Guardar por (dias)"
            onChange={(e) => { setDays(e.target.value); setState("idle"); }} className="h-9" />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Os mais velhos que isso somem sozinhos; os favoritos (estrela) ficam para sempre. Hoje: usando {mb} MB em {settings.usage.count} {settings.usage.count === 1 ? "story" : "stories"} · {starredMb} MB em {settings.usage.starredCount} {settings.usage.starredCount === 1 ? "favorito" : "favoritos"}.
      </p>
      {daysInvalid && <p role="alert" className="text-xs text-destructive">Guardar por 1 a 30 dias.</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={daysInvalid || !changed || state === "saving"} className="cursor-pointer">
          {state === "saving" ? "Salvando…" : "Salvar"}
        </Button>
        {state === "saved" && <span className="fx-fade text-xs text-muted-foreground">Salvo.</span>}
        {state === "failed" && <span className="text-xs text-destructive">Não consegui salvar. Tente novamente.</span>}
      </div>
    </form>
  );
}
