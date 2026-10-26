// Dark is the default and `.light` is the opt-in class (see src/styles.css), so
// the toggle writes the INVERSE of shadcn's usual `.dark`.
export type Theme = "light" | "dark";

const KEY = "socialmate-hub-theme";

export function readTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  if (stored === "light" || stored === "dark") return stored;
  // The panel this mirrors is dark; matching the OS only when it asks for light
  // keeps the two surfaces looking like one product by default.
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("light", theme === "light");
  localStorage.setItem(KEY, theme);
}
