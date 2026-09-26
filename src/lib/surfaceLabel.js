// Surface keys, in pt-BR, for the panel.
//
// A surface key is machine vocabulary: "tag:soulmate", "related:profile:ivy",
// "playlist:7123456789". The panel used to print it raw next to the tally
// ("49 coletados · explore"), which is how a wrong bucket stayed invisible for
// months — "explore" is a plausible-looking word, so nobody read it as a bug.
//
// Panel-only: it imports nothing inlinable and the content scripts never need it.
import { relatedOrigin } from "./shared/surfaceTracker.js";

const PLAIN = {
  explore: "Explorar",
  reels: "Reels",
  feed: "Feed",
  following: "Seguindo",
  live: "Ao vivo",
  post: "Post aberto",
};

/** "tag:soulmate" -> "#soulmate"; "related:profile:ivy" -> "relacionados · @ivy". */
export function surfaceLabel(key) {
  const k = key == null ? "" : String(key);
  if (!k) return "tudo";
  if (k.startsWith("related:")) return `relacionados · ${surfaceLabel(relatedOrigin(k))}`;
  const i = k.indexOf(":");
  if (i < 0) return PLAIN[k] || k;
  const kind = k.slice(0, i);
  const value = k.slice(i + 1);
  switch (kind) {
    case "tag":
      return "#" + value;
    case "search":
      return value ? `busca: ${value}` : "busca";
    case "profile":
      return "@" + value;
    case "tagged":
      return `marcados de @${value}`;
    case "saved":
      return `salvos de @${value}`;
    case "playlist":
      return "playlist";
    case "music":
      return "som";
    default:
      return k;
  }
}

// One line of explanation for the picker, so "relacionados" is not a riddle. A
// related bucket is the recommendation rail of an item you opened — kept, because
// it is often good material, but never mixed into the page you were researching.
export function surfaceHint(key) {
  const k = key == null ? "" : String(key);
  if (k.startsWith("related:")) return `Sugestões que apareceram ao abrir um item de ${surfaceLabel(relatedOrigin(k))}`;
  if (k === "post") return "Itens vistos numa página de post aberta direto pelo link";
  return null;
}

/** A file-name-safe tag for exports: "tag:soulmate" -> "tag_soulmate". */
export function surfaceFileTag(key) {
  const k = key == null ? "" : String(key);
  return (k || "tudo").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "tudo";
}
