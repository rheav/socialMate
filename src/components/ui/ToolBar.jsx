import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ============================================================================
// The ONE shared recipe for a tool's control row in the side panel.
//
// WHY NOT `sm:` / `md:`: Tailwind's default breakpoints are min-width MEDIA
// queries starting at 640px. This panel is an extension page whose window IS the
// side panel — it is ALWAYS narrower than 640px, so those variants could never
// fire. Instead ToolBar declares a named CONTAINER (`@container/toolbar`) and
// the controls inside use `@max-[…]/toolbar:` variants, which react to the
// ROW's own width. That is also more accurate than a media query would be: a
// row's usable width is the panel minus the page's px-4 gutters (minus card
// padding again when the row is nested inside a card), and a container query
// measures exactly that, automatically.
//
// WHY the container is scoped to the row (and to the Shell header) rather than
// to the whole panel: `container-type: inline-size` implies `contain: layout`,
// which makes the element a containing block for `position: fixed` descendants.
// The transcript modals (`fixed inset-0`) live inside the tool panels, so a
// panel-wide container would silently re-anchor them. Toolbars never contain
// overlays, so scoping the container to them is safe.
// ============================================================================

// TWO thresholds, both measured in the real panel font (Outfit,
// html{font-size:15px} — so 1rem is 15px and every Tailwind spacing value is
// 15/16 of its nominal px). Numbers are ROW widths, i.e. panel width minus the
// page's 2×15px gutters (and minus card padding for a nested row).
//
//   • default 308px — labels switch ON at a 339px panel (339 − 30 = 309 > 308).
//     That is where the ordinary 3–4 control rows stop fitting their pt-BR
//     labels. Measured natural (all-labels) widths: WarmTool run-controls 228,
//     IgSort 248, FbComments post picker 266, TtSort 281, FbReels 284. Every one
//     clears 308 with room left for the row's flexible member.
//
//   • dense 390px — labels switch ON at a 422px panel. For a row that is three
//     labelled buttons PLUS a select. PinBoardTool's
//     [Coletar][Limpar][Tudo (N)][Ordem da pasta] measures 447px fully expanded;
//     at the default threshold its labels would switch on at a 339px panel and
//     squeeze the sorter down to 33px — labels technically visible, control
//     useless. 390 is that 447 minus the ~57px the select can give up before it
//     stops reading as a word (it still gets ≥115px anywhere above 390).
//
// A row opts into the second tier with <ToolBar dense>. It works by naming the
// container differently; the controls emit BOTH variants and only the one whose
// named container is actually an ancestor can ever match, so nothing else has
// to know which tier it is in.
export const TOOLBAR_COMPACT_MAX = 308;
export const TOOLBAR_DENSE_COMPACT_MAX = 390;

// Tailwind scans SOURCE TEXT, so these must be literal strings — a template
// literal interpolating the constants above would emit no CSS at all.
const HIDE_WHEN_NARROW = "@max-[308px]/toolbar:hidden @max-[390px]/toolbardense:hidden";
const SHOW_WHEN_NARROW = "@min-[308.05px]/toolbar:hidden @min-[390.05px]/toolbardense:hidden";
const TIGHTEN_WHEN_NARROW = "@max-[308px]/toolbar:px-2 @max-[390px]/toolbardense:px-2";

// A tool's control row: establishes the container and lays the controls out on
// one non-wrapping line that is allowed to shrink (`min-w-0`).
//
// `className` is merged onto the inner row, so a caller can swap the layout
// wholesale (e.g. `grid grid-cols-2 …` — twMerge drops the default `flex`)
// while still getting the container.
export function ToolBar({ dense, className, children, ...props }) {
  return (
    <div
      className={dense ? "@container/toolbardense w-full min-w-0" : "@container/toolbar w-full min-w-0"}
      {...props}
    >
      <div className={cn("flex min-w-0 items-center gap-1.5", className)}>{children}</div>
    </div>
  );
}

// An action button that keeps its icon and drops its label once the row gets
// narrow. `label` is ALWAYS exposed as both `title` and `aria-label`, so the
// icon-only form still explains itself on hover and still has an accessible
// name. `hint` (optional) supplies longer tooltip prose; the accessible name
// stays the label so the two never disagree.
export const ActionButton = React.forwardRef(function ActionButton(
  { icon: Icon, label, hint, iconClassName, className, size = "sm", ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      size={size}
      title={hint || label}
      aria-label={label}
      className={cn(
        // min-w-0: flex items default to min-width:auto, which pins a button to
        // its label's width and pushes the row past the panel edge; with it the
        // label's `truncate` can actually engage. shrink-0 then keeps the button
        // at its (already small) content size so the row's flexible member —
        // normally the ToolSelect — absorbs the squeeze instead.
        //
        // Callers that want a button to FILL the row must pass `basis-0 grow`,
        // not `flex-1`: `flex-1` and `shrink-0` land in different tailwind-merge
        // groups, so both would survive the merge and the winner would depend on
        // Tailwind's stylesheet order rather than on this call site.
        //
        // Padding tightens once the label is gone, so an icon-only button is a
        // tidy square-ish target.
        "min-w-0 shrink-0",
        TIGHTEN_WHEN_NARROW,
        className,
      )}
      {...props}
    >
      {Icon ? <Icon className={cn("size-3.5 shrink-0", iconClassName)} /> : null}
      <span className={cn("truncate", HIDE_WHEN_NARROW)}>{label}</span>
    </Button>
  );
});

// A square icon-only control for a toolbar — no label at any width, same
// accessibility contract as ActionButton (title + aria-label always set).
export const ToolIconButton = React.forwardRef(function ToolIconButton(
  { icon: Icon, label, hint, iconClassName, children, className, variant = "outline", ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      size="sm"
      variant={variant}
      title={hint || label}
      aria-label={label}
      className={cn("size-8 shrink-0 p-0", className)}
      {...props}
    >
      {children || (Icon ? <Icon className={cn("size-3.5 shrink-0", iconClassName)} /> : null)}
    </Button>
  );
});

// The sort/scope <select> that lives in most tool rows.
//
// Two things make it shrink instead of clip:
//   • `min-w-0 flex-1` on the trigger — WITHOUT min-w-0 the flex item keeps its
//     max-content width and shoves the row off the panel edge. That is exactly
//     what sliced "Ordem da pasta" mid-word.
//   • a SHORT label swapped in below the threshold, so the collapsed trigger
//     still reads as a whole word ("Pasta") instead of an ellipsis. Only the
//     trigger text changes — the option list, values and onChange are untouched.
//
// `options`: [{ value, label, short? }]; `short` defaults to `label`.
export function ToolSelect({ value, onValueChange, options, label, className, ...props }) {
  const current = options.find((o) => o.value === value);
  const full = current ? current.label : "";
  const short = current ? current.short || current.label : "";
  return (
    <Select value={value} onValueChange={onValueChange} {...props}>
      <SelectTrigger
        className={cn("h-8 min-w-0 flex-1 gap-1 px-2 text-xs", className)}
        title={label ? `${label}: ${full}` : full}
        aria-label={label || full}
      >
        {/* Radix renders the selected item's text by default; passing children
            overrides that, which is how the trigger can show a shorter word
            when the row is narrow. */}
        <SelectValue>
          <span className={cn("block truncate", HIDE_WHEN_NARROW)}>{full}</span>
          <span className={cn("block truncate", SHOW_WHEN_NARROW)}>{short}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default ToolBar;
