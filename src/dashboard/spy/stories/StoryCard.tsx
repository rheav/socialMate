import { Star } from "lucide-react";
import type { SpyCard, SpyStory } from "../../api";
import { useStoryMedia } from "./useStoryMedia";
import { accountName, durationLabel, hourLabel } from "./storiesFormat";

// One story in a deck, an expanded row or the focus view: the small poster
// (lazy, 144×256) with the hour, the duration, what the story carries and the
// star (a favourite is never pruned). No video here, ever: the viewer mounts
// the only one.
export function StoryCard({
  story,
  account,
  index = 0,
  onOpen,
  onToggleStar,
}: {
  story: SpyStory;
  /** Shown over the poster when the card sits among other accounts' stories. */
  account?: SpyCard;
  /** Position in its row: staggers the entrance (CSS `--i`). */
  index?: number;
  onOpen?: () => void;
  /** Present where a story can be starred (rows and the focus view, not the deck's fan). */
  onToggleStar?: (story: SpyStory) => void;
}) {
  const hour = hourLabel(story.takenAt);
  const dur = durationLabel(story.durationMs);
  const starred = story.starredAt != null;
  const posterUrl = useStoryMedia(story.id, "poster");
  return (
    <div
      role="button"
      data-slot="story"
      data-starred={starred ? "true" : undefined}
      className="sm-story"
      style={{ "--i": index } as React.CSSProperties}
      onClick={onOpen}
      tabIndex={onOpen ? 0 : -1}
      onKeyDown={(e) => {
        if (onOpen && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Story${account ? ` de ${accountName(account)}` : ""} às ${hour}`}
    >
      <img src={posterUrl} alt="" loading="lazy" decoding="async" width={144} height={256} />
      {story.mediaType === 2 && <span className="sm-story-play" aria-hidden="true">▶</span>}
      <span className="sm-story-time">{hour}</span>
      {dur && <span className="sm-story-dur">{dur}</span>}
      {account && <span className="sm-story-who">{accountName(account)}</span>}
      <span className="sm-story-meta">
        {story.links.length > 0 && <span>🔗 link</span>}
        {story.music && <span>♪</span>}
        {story.aiLabel && <span>IA</span>}
      </span>
      {onToggleStar && (
        <button
          type="button"
          className="sm-star"
          aria-label={starred ? "Desfavoritar" : "Favoritar"}
          aria-pressed={starred}
          title={starred ? "Favorito: nunca é apagado. Clique para desmarcar." : "Favoritar: nunca é apagado."}
          onClick={(e) => { e.stopPropagation(); onToggleStar(story); }}
        >
          <Star size={14} fill={starred ? "currentColor" : "none"} />
        </button>
      )}
    </div>
  );
}
