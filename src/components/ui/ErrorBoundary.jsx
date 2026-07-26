import { Component } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

// Contains a crash to the subtree it wraps.
//
// WHY it exists: a throw anywhere inside a tool Panel used to unmount the whole
// side panel — a white screen with no header, no platform switcher and no way back
// except closing and reopening the panel. Wrapped around just the Panel (see
// Shell's WarmTab), the shell stays mounted and the user can switch tool or
// platform out of the broken state.
//
// A class is not a style choice: catching a render error is only exposed through
// these lifecycle methods, there is no hook equivalent.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The card shows the message; the stack only exists here, and the side panel's
    // devtools console is where anyone debugging this will be looking.
    console.error("[socialMate] painel quebrou", error, info?.componentStack);
  }

  // React already unmounted the failed subtree, so clearing the error remounts a
  // fresh Panel rather than re-rendering the broken one.
  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const detail = error?.message || String(error);

    return (
      <div
        role="alert"
        className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-destructive"
      >
        <div className="flex min-w-0 gap-2">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {/* break-words, never truncate: this message is the only clue the user
              (or a bug report) gets about what actually failed. */}
          <div className="min-w-0 space-y-0.5">
            <p className="break-words text-xs font-semibold leading-snug">
              Esta ferramenta travou
            </p>
            <p className="break-words text-[11px] leading-relaxed opacity-90">
              {detail}
            </p>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={this.reset}>
          <RotateCcw />
          Tentar de novo
        </Button>
      </div>
    );
  }
}
