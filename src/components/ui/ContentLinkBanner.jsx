import { AlertTriangle, ExternalLink, Loader2, PlugZap } from "lucide-react";
import { ToolBar, ActionButton } from "@/components/ui/ToolBar";
import { LINK_NO_TAB, linkCopy, linkErrorText } from "@/lib/contentLink";
import { cn } from "@/lib/utils";

// The ONE way a tool tells the user its content script is unreachable — and the
// only place that offers the fix.
//
// Renders nothing while the link is healthy, so every panel can mount it
// unconditionally at the top of its tree and stop inventing its own wording.
//
// WHY it carries a button and not just prose: the old copy ("é necessário
// recarregar") told the user what to do but made them go do it, on a tab they
// might not even have in front of them. The banner that reports the problem is
// the only place that reliably has the tab id, so it is the right place to fix
// it. See useContentLink.revive().
export default function ContentLinkBanner({
  link,
  platformName,
  fixing = false,
  onRevive,
  onOpenTab,
  className,
}) {
  const copy = linkCopy(link?.status, platformName, link?.action);
  if (!copy) return null;

  const noTab = link.status === LINK_NO_TAB;
  // The raw chrome error is more specific than our generic explanation whenever
  // we have one, so prefer it — a translated "a aba não respondeu" beats
  // "isso acontece quando…" for telling the user what actually broke.
  const detail = (!noTab && linkErrorText(link.error)) || copy.detail;

  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border px-3 py-2.5",
        noTab
          ? "border-amber-400/40 bg-amber-400/10 text-amber-700"
          : "border-destructive/40 bg-destructive/10 text-destructive",
        className,
      )}
      role="status"
    >
      <div className="flex min-w-0 gap-2">
        <AlertTriangle className="mt-px size-3.5 shrink-0" />
        {/* break-words, never truncate: this text IS the explanation — losing
            the end of it is how the old hint became easy to miss. */}
        <div className="min-w-0 space-y-0.5">
          <p className="break-words text-xs font-semibold leading-snug">
            {copy.title}
          </p>
          <p className="break-words text-[11px] leading-relaxed opacity-90">
            {detail}
          </p>
        </div>
      </div>

      {/* ToolBar/ActionButton is the shared control recipe (see ToolBar.jsx).
          `basis-0 grow` — NOT flex-1 — is what makes the button fill the row;
          full width also means it never clips at a 260px panel, where the
          shared rule collapses it to its icon (title + aria-label still name
          it, exactly like Iniciar and every other control at that width). */}
      <ToolBar>
        <ActionButton
          icon={fixing ? Loader2 : noTab ? ExternalLink : PlugZap}
          iconClassName={fixing ? "animate-spin" : undefined}
          label={fixing ? "Corrigindo…" : copy.action}
          hint={copy.hint}
          variant={noTab ? "secondary" : "default"}
          className="h-8 basis-0 grow"
          onClick={noTab ? onOpenTab : onRevive}
          disabled={fixing}
        />
      </ToolBar>
    </div>
  );
}
