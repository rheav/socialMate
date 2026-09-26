import { REACH_TIERS } from "@/lib/shared/ttFormat.js";
import {
  Eye,
  Heart,
  MessageCircle,
  Repeat,
  Bookmark,
  Zap,
  User,
  TrendingUp,
  RadioTower,
  Calendar,
  HelpCircle,
} from "lucide-react";

// ============================================================================
// "What do these numbers mean?" — the legend for the stat rail drawn on every
// card and on every in-page overlay.
//
// WHY IT EXISTS: the rail is eight glyphs and no words. Views, likes and
// comments read themselves, but three do not:
//
//   • TE (taxa de engajamento) is a WEIGHTED figure, not a raw ratio, and the
//     weights are editable right above this — so the number is meaningless
//     without knowing what went into it.
//   • The reach multiple used to share a row with the follower count, so
//     "3.4K · 352×" read as if both numbers were followers. Splitting the rows
//     fixed the ambiguity; this explains what the second one actually is.
//   • Saves vs shares are two different TikTok signals that look alike.
//
// Collapsed by default: it is a read-once thing, and open it would push the
// grid — the part the user is here for — off the first screen.
// ============================================================================

// `weights` is the live ER weight set, so the formula shown is the formula
// actually being used rather than a generic one that quietly goes stale.
//
// One legend per network, in the SAME order and with the SAME glyphs the card on
// the page draws (src/lib/shared/overlayUi.js: tower, trend, eye, heart, msg,
// repost, save, zap, user, cal) — the rails on the page are pointer-events:none,
// so this is the only place their icons can be explained.
export default function MetricLegend({ weights, platform = "tiktok" }) {
  const w = weights || {};
  const ig = platform === "instagram";
  const rows = [
    [
      RadioTower,
      "Alcance (views ÷ seguidores)",
      ig
        ? "12× = o total de views equivale a 12 vezes o número de seguidores do autor. Compara as views ao tamanho da conta; não mede pessoas únicas nem revela se quem assistiu era seguidor. As cores seguem a escala abaixo. Só aparece quando conhecemos os seguidores do autor; em hashtag e busca esse dado pode faltar."
        : "352× = o total de views equivale a 352 vezes o número de seguidores do autor. Compara as views ao tamanho da conta; não mede pessoas únicas nem revela se quem assistiu era seguidor. As cores seguem a escala abaixo. Só aparece quando conhecemos os seguidores do autor.",
    ],
    [
      TrendingUp,
      "Velocidade (views por dia)",
      "2.5K/dia = em média 2.500 views por dia desde a publicação (total de views ÷ dias). Exemplo: 1,2 milhão de views em 3 dias = 400K/dia. É a média do período inteiro, não as views de hoje nem a velocidade em tempo real. Aparece quando temos views e data, inclusive em hashtag e busca. Post com menos de um dia conta como um dia.",
    ],
    [Eye, "Visualizações", "Quantas vezes o vídeo foi reproduzido (replays contam)."],
    [Heart, "Curtidas", null],
    [MessageCircle, "Comentários", null],
    ig
      ? [Repeat, "Reposts", "Quantas vezes o post foi repostado por outras contas."]
      : [Repeat, "Compartilhamentos", "Enviado para alguém ou repostado."],
    ...(ig ? [] : [[Bookmark, "Salvamentos", "Guardado nos favoritos — intenção de voltar."]]),
    [
      Zap,
      "TE — taxa de engajamento (o raio)",
      ig
        ? `Quanto o público interage por view, ponderado: (curtidas×${w.like ?? 1} + coment.×${w.comment ?? 4} + reposts×${w.repost ?? 4}) ÷ views × 100. Os pesos são os de "Peso do TE" logo acima; um peso maior dá mais importância àquela interação.`
        : `Quanto o público interage por view, ponderado: (curtidas×${w.like ?? 1} + coment.×${w.comment ?? 4} + compart.×${w.share ?? 4} + salvos×${w.save ?? 2}) ÷ views × 100. Os pesos são os de "Peso do TE" logo acima.`,
    ],
    ...(ig ? [] : [[User, "Seguidores do perfil", "O tamanho da conta que publicou."]]),
    [Calendar, "Data de publicação", null],
  ];

  return (
    <details className="group rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs text-foreground [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-1.5">
          <HelpCircle className="size-3.5 shrink-0 text-muted-foreground" />
          O que significam os números
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground group-open:hidden">abrir</span>
      </summary>
      <dl className="space-y-2 border-t border-border px-3 py-2.5">
        {rows.map(([Icon, term, desc]) => (
          <div key={term} className="flex gap-2">
            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <dt className="text-[11.5px] font-semibold text-foreground">{term}</dt>
              {desc ? (
                <dd className="text-[11px] leading-snug text-muted-foreground">{desc}</dd>
              ) : null}
            </div>
          </div>
        ))}
        {/* The grade ladder, drawn from the same REACH_TIERS the card colours
            itself from — so the key can never describe a scale the cards are
            not using. */}
        <div className="border-t border-border pt-2">
          <div className="mb-1.5 text-[11px] font-semibold text-foreground">Escala de alcance</div>
          <div className="space-y-1">
            {REACH_TIERS.map((t, i) => {
              const next = REACH_TIERS[i + 1];
              const range = t.min === 0 ? "< 1×" : next ? `${t.min}–${next.min}×` : `${t.min}×+`;
              return (
                <div key={t.key} className="flex items-center gap-2 text-[11px]">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: t.color }} />
                  <span className="w-14 shrink-0 tabular-nums font-semibold" style={{ color: t.color }}>
                    {range}
                  </span>
                  <span className="min-w-0 text-muted-foreground">{t.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </dl>
    </details>
  );
}
