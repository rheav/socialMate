import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Settings } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Gear-button settings dropdown — same approach as unfunnelizer's OptionsDropdown:
// header trigger, click-outside close, scrollable sections with info tooltips.
export default function OptionsDropdown({
  pacing, setPacing,
  thresholds, setThresholds,
  sessionCap, setSessionCap,
  disabled,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        title="Options"
        className="flex items-center rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <Settings size={16} />
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 z-50 mt-2 w-72 rounded-xl border border-slate-300 bg-white/95 backdrop-blur-md shadow-xl">
          <div className="max-h-96 overflow-y-auto p-4">
            <Section
              title="Pacing"
              tooltip="Random waits between actions, and how long each video is watched (dwell). Values are ranges — a random point inside is picked every time, so the run never looks metronomic."
            >
              <div className="grid grid-cols-2 gap-2.5">
                <Field id="opt-amin" label="Action min (s)" value={pacing.minDelay} disabled={disabled}
                  onChange={(v) => setPacing((p) => ({ ...p, minDelay: v }))} />
                <Field id="opt-amax" label="Action max (s)" value={pacing.maxDelay} disabled={disabled}
                  onChange={(v) => setPacing((p) => ({ ...p, maxDelay: v }))} />
                <Field id="opt-rmin" label="Dwell min (s)" value={pacing.reelMin} disabled={disabled}
                  onChange={(v) => setPacing((p) => ({ ...p, reelMin: v }))} />
                <Field id="opt-rmax" label="Dwell max (s)" value={pacing.reelMax} disabled={disabled}
                  onChange={(v) => setPacing((p) => ({ ...p, reelMax: v }))} />
              </div>
            </Section>

            <Section
              title="Engagement filters"
              tooltip="Only save/like/follow posts with at least this many likes or comments (read from the post's own counters). Posts below the threshold are still watched and scrolled past — they just get no action. 0 turns a filter off."
            >
              <div className="grid grid-cols-2 gap-2.5">
                <Field id="opt-ml" label="Min likes" value={thresholds.minLikes} disabled={disabled}
                  onChange={(v) => setThresholds((t) => ({ ...t, minLikes: v }))} />
                <Field id="opt-mc" label="Min comments" value={thresholds.minComments} disabled={disabled}
                  onChange={(v) => setThresholds((t) => ({ ...t, minComments: v }))} />
              </div>
            </Section>

            <Section
              title="Session"
              tooltip="Hard time cap for a run, in minutes. The run stops when it's reached even if the post target isn't. 0 = no cap."
              noBorder
            >
              <Field id="opt-cap" label="Session cap (min)" value={sessionCap} disabled={disabled}
                onChange={setSessionCap} />
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ id, label, value, onChange, disabled }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} />
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
      className="fixed w-56 p-2.5 rounded-lg z-[9999] shadow-xl bg-white/95 backdrop-blur-md text-slate-800 border border-slate-300 text-[10px] leading-relaxed"
      style={{ top: position.top, left: position.left, transform: "translateY(-100%)" }}
    >
      {children}
      <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-white" />
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
        <span className="text-[10px] font-semibold tracking-wider text-foreground uppercase">{title}</span>
        <div
          ref={iconRef}
          onMouseEnter={() => setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
          className="relative flex items-center"
        >
          <Info size={12} className="text-muted-foreground cursor-help transition-colors" />
          <Tooltip targetRef={iconRef} visible={showTooltip}>{tooltip}</Tooltip>
        </div>
      </div>
      {children}
    </div>
  );
}
