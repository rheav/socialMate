import { cn } from "@/lib/utils";

// The small frosted icon button that sits on top of a media thumbnail (download,
// thumbnail, transcribe, save…).
//
// This was defined four times across the tool panes and inlined twice more, and the
// copies had already drifted: TtSortTool's was `bg-black/55` where every other was
// `bg-black/65`, so the TikTok grid's buttons were visibly lighter for no reason.
//
// It also fixes an accessibility gap all six copies shared: they passed only
// `title`, so the buttons were unnamed to a screen reader (an icon has no text).
// `aria-label` falls back to `title` here, which is the right name in every current
// call site — pass `aria-label` explicitly when the two should differ.
export default function IconBtn({ children, className, title, ...props }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={props["aria-label"] ?? title}
      {...props}
      className={cn(
        "grid size-6 place-items-center rounded-md bg-black/65 text-white sw-hoverable hover:bg-black/80 disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}
