import { cn } from "@/dashboard/lib/utils";

/**
 * Text with a light passing over it (effects.css, `.fx-shiny`): the text stays
 * muted while a soft window with a bright copy slides across it. The copy is
 * drawn from `data-text`, so the text is read and copied once.
 */
export function ShinyText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("fx-shiny", className)}>
      {text}
      <span className="fx-shiny-light" aria-hidden="true">
        <span data-text={text} />
      </span>
    </span>
  );
}
