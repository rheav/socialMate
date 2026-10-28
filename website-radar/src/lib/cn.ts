// Island-side `cn`: clsx only. tailwind-merge (src/lib/utils.ts) costs ~18 KB gzip in the
// browser and the islands never pass conflicting classes.
export { clsx as cn } from "clsx";
