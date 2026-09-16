import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cloud, Moon, Sun, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import useStoredFlag from "@/lib/useStoredFlag";
import { useSyncSettings } from "@/lib/useSyncSettings";
import {
  TRANSCRIPT_CAP_KEY,
  TRANSCRIPT_CAP_OPTIONS,
  normalizeTranscriptCap,
  readTranscriptCap,
  writeTranscriptCap,
} from "@/lib/transcriptCap";
import { TX_LANG_OPTIONS } from "@/lib/shared/txLang.js";
import {
  TRANSCRIPT_LANGUAGE_KEY,
  normalizeTranscriptLanguage,
  readStoredTranscriptLanguage,
  writeStoredTranscriptLanguage,
} from "@/lib/transcriptionLanguage";

// Opções — one place for every setting that is about the PANEL rather than about
// a running job. Before this the settings were spread over the surfaces that
// happened to need them: the theme lived in the header, the page-overlay switches
// in each Sort tool's toolbar, the transcription language in the Arquivo tab, and
// Pinterest's overlay had no switch at all — it could only be changed by editing
// storage. So "where do I turn that off" had a different answer every time.
//
// What does NOT belong here: the warmer's gear (ritmo, limites, captura
// automática). Those configure the session you are about to run, they live in the
// form that runs it, and they are meaningless while the warmer is hidden.
//
// A modal rather than a dropdown: the panel is 260-400px wide, and a dropdown
// wide enough for three sections would hang off its own edge (the warmer's gear
// already has to cap its width to the viewport). The modal owns the panel while
// it is open, which is also what makes it a fine home for settings you visit
// rarely and then leave alone.
export default function OptionsModal({ open, onClose, prefs, setPrefs, theme, setTheme }) {
  const cardRef = useRef(null);
  const closeRef = useRef(null);
  const [igOverlay, setIgOverlay] = useStoredFlag("sw_ig_overlay");
  const [ttOverlay, setTtOverlay] = useStoredFlag("sw_tt_overlay");
  const [pinOverlay, setPinOverlay] = useStoredFlag("sw_pin_overlay");

  // Escape closes; the listener only exists while the modal does.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // The close button takes focus on open, so Tab starts inside the dialog and
  // Enter/Space dismisses it without reaching for the mouse.
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/45 p-4 backdrop-blur-[2px]"
      // Only a press that both starts AND ends on the backdrop closes it — a drag
      // that began on a switch and released outside must not dismiss the dialog.
      onMouseDown={(e) => {
        if (!cardRef.current?.contains(e.target)) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="Opções"
        className="sw-pop my-8 w-full max-w-sm rounded-2xl border border-border bg-card text-card-foreground shadow-2xl"
      >
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Opções</h2>
          <button
            ref={closeRef}
            onClick={onClose}
            title="Fechar"
            aria-label="Fechar"
            className="sw-hoverable grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-4 py-3">
          <Section title="Painel">
            <Row
              id="opt-show-warm"
              label="Mostrar Aquecer"
              hint="Esconde a aba do aquecedor. Nada é apagado: sessões, ritmo e limites continuam salvos e voltam ao religar."
              checked={prefs.showWarm !== false}
              onChange={(v) => setPrefs((p) => ({ ...p, showWarm: v }))}
            />
            <div className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-sm text-foreground">Tema</span>
              <Choice
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "light", label: "Claro", Icon: Sun },
                  { value: "dark", label: "Escuro", Icon: Moon },
                ]}
              />
            </div>
          </Section>

          <Section
            title="Sobreposições nas páginas"
            hint="Os selos de estatísticas e os botões (salvar, baixar, transcrever) desenhados sobre os posts da própria rede."
          >
            <Row
              id="opt-ovl-ig"
              label="Instagram"
              checked={igOverlay}
              onChange={setIgOverlay}
            />
            <Row id="opt-ovl-tt" label="TikTok" checked={ttOverlay} onChange={setTtOverlay} />
            <Row
              id="opt-ovl-pin"
              label="Pinterest"
              checked={pinOverlay}
              onChange={setPinOverlay}
            />
          </Section>

          <ArchiveSection />

          <HubSection />

          <Section
            title="Transcrição"
            hint="Idioma das PRÓXIMAS transcrições. As já feitas guardam o idioma com que foram geradas."
            noBorder
          >
            <div className="flex items-center justify-between gap-3 py-1.5">
              <span className="text-sm text-foreground">Idioma padrão</span>
              <TxLanguageChoice />
            </div>
          </Section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, hint, children, noBorder }) {
  return (
    <section className={noBorder ? "py-3" : "border-b border-border py-3"}>
      <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-fg/45">
        {title}
      </h3>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      <div className="mt-2 space-y-1">{children}</div>
    </section>
  );
}

function Row({ id, label, hint, checked, onChange }) {
  return (
    <div className="py-0.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="min-w-0 cursor-pointer text-sm text-foreground">
          {label}
        </Label>
        <Switch id={id} className="shrink-0" checked={checked} onCheckedChange={onChange} />
      </div>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

// Small segmented picker for the settings that are a choice, not a switch.
function Choice({ value, onChange, options }) {
  return (
    <div className="flex flex-none items-center gap-0.5 rounded-md border border-border p-0.5">
      {options.map(({ value: v, label, Icon }) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          title={label}
          className={
            value === v
              ? "flex items-center gap-1 rounded-[4px] bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground"
              : "flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground hover:text-foreground"
          }
        >
          {Icon && <Icon className="size-3" />}
          {label}
        </button>
      ))}
    </div>
  );
}

// The same stored key the Arquivo tab and the on-page Transcrever menus write,
// so a change here IS a change there (and vice versa, while this is open).
function TxLanguageChoice() {
  const [lang, setLang] = useState(null);
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    readStoredTranscriptLanguage().then(setLang).catch(() => {});
    const onCh = (c, area) => {
      if (area === "local" && c[TRANSCRIPT_LANGUAGE_KEY])
        setLang(normalizeTranscriptLanguage(c[TRANSCRIPT_LANGUAGE_KEY].newValue));
    };
    chrome.storage.onChanged?.addListener(onCh);
    return () => chrome.storage.onChanged?.removeListener(onCh);
  }, []);
  if (lang === null) return null;
  return (
    <Choice
      value={lang}
      onChange={(v) => writeStoredTranscriptLanguage(v).then(setLang)}
      options={TX_LANG_OPTIONS.map((o) => ({ value: o.value, label: o.short }))}
    />
  );
}

// ---- Acervo (hub) ----
// The local Arquivo is capped on purpose (20 transcrições, 300 salvos), so the
// hub is where the history actually lives. Three controls, in the order someone
// sets them up: where, the key, and then the switch — with "testar" between the
// key and the switch because a token typed wrong is the only failure that looks
// exactly like everything working.
function HubSection() {
  const { settings, state, ready, save, ensureHost, ping, syncAll } = useSyncSettings();
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);

  if (!ready) return null;

  const run = async (kind, fn) => {
    setBusy(kind);
    setResult(null);
    try {
      setResult(await fn());
    } catch (e) {
      setResult({ ok: false, error: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  };

  const test = () =>
    run("ping", async () => {
      // The permission has to be asked for from this click; see useSyncSettings.
      if (!(await ensureHost(settings.url))) return { ok: false, error: "permissão negada para esse endereço" };
      const r = await ping();
      return r?.ok
        ? { ok: true, note: `${r.counts?.transcripts ?? 0} transcrições e ${r.counts?.saved ?? 0} salvos no acervo` }
        : { ok: false, error: r?.status === 401 ? "token recusado" : r?.error || "sem resposta" };
    });

  const pushAll = () =>
    run("all", async () => {
      if (!(await ensureHost(settings.url))) return { ok: false, error: "permissão negada para esse endereço" };
      const r = await syncAll();
      return r?.ok ? { ok: true, note: `${r.sent ?? 0} registros enviados` } : { ok: false, error: r?.error || "falhou" };
    });

  return (
    <Section
      title="Acervo (backend)"
      hint="O Arquivo local é limitado — 20 transcrições e 300 salvos, e cada um carrega a miniatura. O acervo guarda tudo: nada expira, 'limpar tudo' não chega lá e sobrevive a reinstalar a extensão. O envio é só de ida; apagar aqui não apaga lá."
    >
      <label className="block py-1">
        <span className="text-[11px] text-muted-foreground">Endereço</span>
        <input
          value={settings.url}
          onChange={(e) => save({ url: e.target.value })}
          placeholder="https://socialmate.rheav.dev"
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary"
        />
      </label>
      <label className="block py-1">
        <span className="text-[11px] text-muted-foreground">Token de sincronização</span>
        <input
          type="password"
          value={settings.token}
          onChange={(e) => save({ token: e.target.value })}
          placeholder="SYNC_TOKEN do servidor"
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2 py-1.5">
        <button
          onClick={test}
          disabled={busy != null || !settings.url || !settings.token}
          className="sw-hoverable flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <Cloud className="size-3" /> {busy === "ping" ? "testando…" : "testar conexão"}
        </button>
        <button
          onClick={pushAll}
          disabled={busy != null || !settings.enabled}
          title={settings.enabled ? "Enviar tudo o que já está no Arquivo" : "Ligue o envio automático primeiro"}
          className="sw-hoverable rounded-lg border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {busy === "all" ? "enviando…" : "sincronizar tudo"}
        </button>
      </div>

      <Row
        id="opt-sync-enabled"
        label="Enviar automaticamente"
        hint="Cada transcrição e cada vídeo salvo sobem para o acervo logo depois de serem gravados aqui."
        checked={settings.enabled}
        onChange={(v) => save({ enabled: v })}
      />

      {result && (
        <p className={result.ok ? "text-[11px] text-good" : "text-[11px] text-destructive"}>
          {result.ok ? result.note : result.error}
        </p>
      )}
      {!result && state?.error && <p className="text-[11px] text-destructive">último envio: {state.error}</p>}
      {!result && !state?.error && state?.lastOkAt && (
        <p className="text-[11px] text-muted-foreground">
          último envio: {new Date(state.lastOkAt).toLocaleString()} ({state.lastSent ?? 0} registros)
        </p>
      )}
    </Section>
  );
}

// ---- Arquivo ----
// How many transcriptions to keep. It used to be 20, hard-coded, and the number
// was never the point: the store is one object re-serialized on every write,
// with a thumbnail inside every record, so the cap is what keeps a write cheap.
// Whose ceiling that should be is the user's call — so it is a setting, with the
// cost of "sem limite" stated instead of discovered.
function ArchiveSection() {
  const [cap, setCap] = useState(null);

  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    readTranscriptCap().then(setCap).catch(() => {});
    const onCh = (c, area) => {
      if (area === "local" && c[TRANSCRIPT_CAP_KEY]) setCap(normalizeTranscriptCap(c[TRANSCRIPT_CAP_KEY].newValue));
    };
    chrome.storage.onChanged?.addListener(onCh);
    return () => chrome.storage.onChanged?.removeListener(onCh);
  }, []);

  if (cap === null) return null;
  const current = TRANSCRIPT_CAP_OPTIONS.find((o) => o.value === cap);

  return (
    <Section
      title="Arquivo"
      hint="Quantas transcrições ficam guardadas aqui. As mais antigas saem primeiro quando o limite é atingido — e o que já subiu para o acervo NÃO é apagado de lá."
    >
      <div className="flex items-center justify-between gap-3 py-1.5">
        <span className="text-sm text-foreground">Máximo de transcrições</span>
        <Choice
          value={cap}
          onChange={(v) => writeTranscriptCap(v).then(() => setCap(normalizeTranscriptCap(v)))}
          options={TRANSCRIPT_CAP_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>
      {current?.hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{current.hint}</p>}
    </Section>
  );
}
