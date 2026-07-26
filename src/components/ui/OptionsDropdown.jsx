import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Settings } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

// Gear-button settings dropdown — same approach as unfunnelizer's OptionsDropdown:
// header trigger, click-outside close, scrollable sections with info tooltips.
export default function OptionsDropdown({
  pacing,
  setPacing,
  thresholds,
  setThresholds,
  autoCapture,
  setAutoCapture,
  maxItems,
  setMaxItems,
  disabled,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);

  // Both listeners are document-wide, so they only exist while the popup does —
  // a closed dropdown must not be inspecting every mousedown/keydown in the panel.
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setIsOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        title="Opções"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className="flex items-center rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <Settings size={16} />
      </button>

      {isOpen && (
        // max-w: the popup is right-anchored, so at a 260px panel a fixed 18rem
        // (270px) would hang off the LEFT edge and be unreachable. Cap it to the
        // viewport minus the page gutters.
        <div
          role="dialog"
          aria-label="Opções"
          className="absolute top-full right-0 z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card/95 text-card-foreground backdrop-blur-md shadow-xl"
        >
          <div className="max-h-96 overflow-y-auto p-4">
            <Section
              title="Ritmo"
              tooltip="Esperas aleatórias entre as ações e por quanto tempo cada vídeo é assistido (permanência). Os valores são intervalos — um ponto aleatório dentro deles é escolhido a cada vez, para que a sessão nunca pareça mecânica."
            >
              <div className="grid grid-cols-2 gap-2.5">
                {/* min=1: a zero-second wait or dwell is not a setting, it is a
                    broken session — the background already refuses 0 and falls
                    back to its own default. */}
                <Field
                  id="opt-amin"
                  label="Ação mín. (s)"
                  value={pacing.minDelay}
                  min={1}
                  disabled={disabled}
                  onChange={(v) => setPacing((p) => ({ ...p, minDelay: v }))}
                />
                <Field
                  id="opt-amax"
                  label="Ação máx. (s)"
                  value={pacing.maxDelay}
                  min={1}
                  disabled={disabled}
                  onChange={(v) => setPacing((p) => ({ ...p, maxDelay: v }))}
                />
                <Field
                  id="opt-rmin"
                  label="Permanência mín. (s)"
                  value={pacing.reelMin}
                  min={1}
                  disabled={disabled}
                  onChange={(v) => setPacing((p) => ({ ...p, reelMin: v }))}
                />
                <Field
                  id="opt-rmax"
                  label="Permanência máx. (s)"
                  value={pacing.reelMax}
                  min={1}
                  disabled={disabled}
                  onChange={(v) => setPacing((p) => ({ ...p, reelMax: v }))}
                />
              </div>
            </Section>

            <Section
              title="Filtros de engajamento"
              tooltip="Salva/curte/segue apenas posts com pelo menos essa quantidade de curtidas ou comentários (lido dos contadores do próprio post). Posts abaixo do limite ainda são assistidos e passados — só não recebem nenhuma ação. 0 desativa o filtro."
            >
              <div className="grid grid-cols-2 gap-2.5">
                <Field
                  id="opt-ml"
                  label="Curtidas mín."
                  value={thresholds.minLikes}
                  disabled={disabled}
                  onChange={(v) =>
                    setThresholds((t) => ({ ...t, minLikes: v }))
                  }
                />
                <Field
                  id="opt-mc"
                  label="Comentários mín."
                  value={thresholds.minComments}
                  disabled={disabled}
                  onChange={(v) =>
                    setThresholds((t) => ({ ...t, minComments: v }))
                  }
                />
              </div>
            </Section>

            <Section
              title="Captura automática (Facebook)"
              tooltip="Durante o aquecimento, todo post em vídeo que ultrapassar esses limites é automaticamente enfileirado para transcrição e/ou download, e salvo na aba Salvos (favoritos). Os limites são lidos dos contadores de cada post; 0 = filtro desativado (defina só um, se preferir). Cada vídeo é capturado no máximo uma vez por sessão."
            >
              <div className="flex items-center justify-between mb-2.5">
                <Label
                  htmlFor="opt-ac-en"
                  className="text-sm text-foreground cursor-pointer"
                >
                  Ativar captura automática
                </Label>
                <Switch
                  id="opt-ac-en"
                  checked={!!autoCapture.enabled}
                  disabled={disabled}
                  onCheckedChange={(v) =>
                    setAutoCapture((a) => ({ ...a, enabled: v }))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <Field
                  id="opt-ac-ml"
                  label="Curtidas mín."
                  value={autoCapture.minLikes}
                  disabled={disabled || !autoCapture.enabled}
                  onChange={(v) =>
                    setAutoCapture((a) => ({ ...a, minLikes: v }))
                  }
                />
                <Field
                  id="opt-ac-mc"
                  label="Comentários mín."
                  value={autoCapture.minComments}
                  disabled={disabled || !autoCapture.enabled}
                  onChange={(v) =>
                    setAutoCapture((a) => ({ ...a, minComments: v }))
                  }
                />
              </div>
              <div className="mt-3 space-y-2">
                {[
                  ["transcribe", "Transcrever"],
                  ["download", "Baixar"],
                  ["favorite", "Salvar nos favoritos"],
                ].map(([k, label]) => (
                  <div key={k} className="flex items-center justify-between">
                    <Label
                      htmlFor={`opt-ac-${k}`}
                      className="text-sm text-foreground cursor-pointer"
                    >
                      {label}
                    </Label>
                    <Switch
                      id={`opt-ac-${k}`}
                      checked={autoCapture[k] !== false}
                      disabled={disabled || !autoCapture.enabled}
                      onCheckedChange={(v) =>
                        setAutoCapture((a) => ({ ...a, [k]: v }))
                      }
                    />
                  </div>
                ))}
              </div>
            </Section>

            <Section
              title="Sessão"
              tooltip="Limite rígido de quantos posts são processados em uma sessão. A sessão para ao atingir esse limite, mesmo que o tempo ainda não tenha acabado. 0 = sem limite."
              noBorder
            >
              <Field
                id="opt-cap"
                label="Máx. de itens (0 = sem limite)"
                value={maxItems}
                disabled={disabled}
                onChange={setMaxItems}
              />
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}

// `min` is the field's floor: 0 where zero carries a meaning ("filtro
// desativado", "sem limite") and 1 where it does not (see the pacing fields).
function Field({ id, label, value, onChange, disabled, min = 0 }) {
  // An <input type="number"> hands back a STRING, and the browser reports "" for
  // anything it could not parse (a lone "-", a half-typed exponent) as well as
  // for a genuinely emptied box. "" is passed through untouched so the field
  // stays clearable while typing — coercing it here would park NaN in state and
  // freeze the input; every consumer already reads a blank as its default.
  const commit = (raw) => {
    if (raw === "") return onChange("");
    const n = Number(raw);
    if (!Number.isFinite(n)) return; // garbage: keep the last good value
    onChange(Math.max(min, n));
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        inputMode="numeric"
        value={value}
        disabled={disabled}
        onChange={(e) => commit(e.target.value)}
      />
    </div>
  );
}

function Tooltip({ children, targetRef, visible }) {
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (visible && targetRef.current) {
      const rect = targetRef.current.getBoundingClientRect();
      const tooltipWidth = 224;
      const padding = 8;
      let left = rect.left + rect.width / 2 - tooltipWidth / 2;
      if (left < padding) left = padding;
      if (left + tooltipWidth > window.innerWidth - padding)
        left = window.innerWidth - tooltipWidth - padding;
      setPosition({ top: rect.top - 8, left });
    }
  }, [visible, targetRef]);

  if (!visible) return null;

  return createPortal(
    <div
      className="fixed w-56 p-2.5 rounded-lg z-[9999] shadow-xl bg-card/95 backdrop-blur-md text-card-foreground border border-border text-[10px] leading-relaxed"
      style={{
        top: position.top,
        left: position.left,
        transform: "translateY(-100%)",
      }}
    >
      {children}
      {/* border-t-card/95 keeps the arrow the same colour as the bubble above it
          in either theme — the arrow IS the background, drawn as a border. */}
      <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-card/95" />
    </div>,
    document.body,
  );
}

function Section({ title, tooltip, noBorder, children }) {
  const [showTooltip, setShowTooltip] = useState(false);
  const iconRef = useRef(null);

  return (
    <div className={noBorder ? "" : "mb-4 pb-4 border-b border-border"}>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[10px] font-semibold tracking-wider text-foreground uppercase">
          {title}
        </span>
        <div
          ref={iconRef}
          onMouseEnter={() => setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
          className="relative flex items-center"
        >
          <Info
            size={12}
            className="text-muted-foreground cursor-help transition-colors"
          />
          <Tooltip targetRef={iconRef} visible={showTooltip}>
            {tooltip}
          </Tooltip>
        </div>
      </div>
      {children}
    </div>
  );
}
