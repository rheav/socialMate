import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared focus/scroll ownership for the two Spy modals. `companion` is a panel
 * that opens over the dialog (the account's report): focus may live there too,
 * and Tab skips whatever is inert (the dialog under it).
 */
export function useSpyDialog(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void, companion?: RefObject<HTMLElement | null>) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const inside = (node: Node | null) => !!node && (dialog.contains(node) || !!companion?.current?.contains(node));
    const focusable = () => [dialog, companion?.current].filter((el): el is HTMLElement => !!el).flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'
    ))).filter((el) => !el.hidden && el.getAttribute("aria-hidden") !== "true" && !el.closest("[inert]"));
    // An autofocus textarea (for example after editing) should retain its focus.
    if (!dialog.contains(document.activeElement)) (focusable()[0] ?? dialog).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === "Tab") {
        const items = focusable();
        const first = items[0] ?? dialog;
        const last = items[items.length - 1] ?? dialog;
        if (!inside(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (!inside(event.target as Node)) (focusable()[0] ?? dialog).focus();
    };
    window.addEventListener("keydown", keydown);
    document.addEventListener("focusin", containFocus);
    return () => {
      window.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", containFocus);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open, ref]);
}
