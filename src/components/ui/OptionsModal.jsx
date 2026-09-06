import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Moon, Sun, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import useStoredFlag from "@/lib/useStoredFlag";
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
