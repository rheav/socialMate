/**
 * i18n configuration and helpers.
 *
 * Routing: pt-BR lives at the root (/, /privacy…); English lives under /en. URLs never end with a slash (root excepted).
 *
 *   const lang = getLangFromUrl(Astro.url);
 *   const t = useTranslations(lang);
 */

import { en, type TranslationKeys } from "./translations/en";
import { ptBr } from "./translations/pt-br";

export const languages = {
  "pt-br": "Português",
  en: "English",
} as const;

export const defaultLang = "pt-br" as const;
export const siteUrl = "https://socialradar.pages.dev"; // shortcut: placeholder, same as astro.config.mjs

export type Lang = keyof typeof languages;
export type { TranslationKeys };

/** BCP 47 codes for <html lang>, hreflang and JSON-LD. */
export const langTags: Record<Lang, string> = { "pt-br": "pt-BR", en: "en" };

export const ui: Record<Lang, Record<TranslationKeys, string>> = {
  en,
  "pt-br": ptBr,
};

const prefixed = /^\/(en)(?=\/|\.html$|$)/;

/** getStaticPaths entries for a page that exists in every language (`[...lang]` routes). */
export function localeStaticPaths() {
  return [{ params: { lang: undefined } }, { params: { lang: "en" } }];
}

export function getLangFromUrl(url: URL): Lang {
  const m = url.pathname.match(prefixed);
  return m ? (m[1] as Lang) : defaultLang;
}

export function useTranslations(lang: Lang) {
  return function t(key: TranslationKeys): string {
    return ui[lang]?.[key] || ui[defaultLang][key] || key;
  };
}

/** Path without language prefix, without .html and without trailing slash ("/" for the home). */
export function getCleanPath(pathname: string): string {
  const p = pathname.replace(prefixed, "").replace(/\.html$/, "").replace(/\/index$/, "").replace(/\/+$/, "");
  return p || "/";
}

/**
 * Localized path for a site-relative path, keeping a #hash.
 * getLocalizedPath("en", "/docs#x") -> "/en/docs#x"; getLocalizedPath("pt-br", "/") -> "/".
 */
export function getLocalizedPath(lang: Lang, path: string): string {
  const [pathPart, hash] = path.split("#");
  const clean = getCleanPath(pathPart.startsWith("/") ? pathPart : `/${pathPart}`);
  const base = lang === defaultLang ? clean : clean === "/" ? `/${lang}` : `/${lang}${clean}`;
  return hash ? `${base}#${hash}` : base;
}

/** Absolute URL of the current page in another language. */
export function getLocalizedUrl(lang: Lang, pathname: string): string {
  const path = getLocalizedPath(lang, getCleanPath(pathname));
  return path === "/" ? `${siteUrl}/` : `${siteUrl}${path}`;
}

/** hreflang alternates for the current page (every language + x-default -> pt-BR). */
export function getAlternateUrls(pathname: string) {
  const alternates = (Object.keys(languages) as Lang[]).map((lang) => ({
    lang: langTags[lang],
    url: getLocalizedUrl(lang, pathname),
  }));
  return [...alternates, { lang: "x-default", url: getLocalizedUrl(defaultLang, pathname) }];
}
