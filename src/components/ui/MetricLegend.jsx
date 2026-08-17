import { REACH_TIERS } from "@/lib/shared/ttFormat.js";
import {
  Eye,
  Heart,
  MessageCircle,
  Share2,
  Bookmark,
  Zap,
  Users,
  TrendingUp,
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
export default function MetricLegend({ weights }) {
  const w = weights || {};
  const rows = [
    [Eye, "Visualizações", "Quantas vezes o vídeo foi reproduzido."],
    [Heart, "Curtidas", null],
    [MessageCircle, "Comentários", null],
    [Share2, "Compartilhamentos", "Enviado para alguém ou repostado."],
    [Bookmark, "Salvamentos", "Guardado nos favoritos — intenção de voltar."],
    [
      Zap,
      "TE — taxa de engajamento",
      `Engajamento ponderado ÷ views. Com os pesos atuais: (curtidas×${w.like ?? 1} + coment.×${w.comment ?? 4} + compart.×${w.share ?? 4} + salvos×${w.save ?? 2}) ÷ views × 100.`,
    ],
    [Users, "Seguidores do perfil", "O tamanho da conta que publicou."],
    [
      TrendingUp,
      "Alcance (views por seguidor)",
      "Views ÷ seguidores, e o primeiro número do card. 352× = o vídeo alcançou 352 vezes o próprio público. Acima de 1× ele saiu da base de seguidores e foi levado pelo Para Você; abaixo de 1× ficou dentro dela. É o número que diz se o formato funcionou, independente do tamanho da conta — por isso ele lidera e vem com cor.",
    ],
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
