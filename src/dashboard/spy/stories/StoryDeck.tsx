import { BorderBeam } from "@/dashboard/ui/border-beam";
import { cn } from "@/dashboard/lib/utils";
import type { SpyCard, SpyStory } from "../../api";
import { StoryCard } from "./StoryCard";
import { AccountAvatar } from "./StoriesTray";
import { accountName, agoLabel } from "./storiesFormat";

// One account's deck: the three newest posters fanned out, the count and when
// the last story was posted. Clicking opens the account's row in the grid. An
// amber beam runs along it while it has stories captured since the last visit.
export function StoryDeck({
  account,
  stories,
  fresh,
  open,
  now,
  index = 0,
  onToggle,
}: {
  account: SpyCard;
  /** Newest first. */
  stories: SpyStory[];
  /** Stories captured since the last visit. */
  fresh: number;
  open: boolean;
  now: number;
  /** Position in the grid: staggers the entrance (CSS `--i`). */
  index?: number;
  onToggle: () => void;
}) {
  const top = stories.slice(0, 3).reverse();
  return (
    <article
      data-slot="deck"
      data-new={fresh > 0 ? "true" : undefined}
      className={cn("sm-deck", open && "open")}
      style={{ "--i": index } as React.CSSProperties}
      tabIndex={0}
      aria-label={`Stories de ${accountName(account)}`}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <div className="sm-deck-head">
        <AccountAvatar profile={account} />
        <div className="min-w-0">
          <div className="sm-deck-name">{accountName(account)}</div>
          <div className="sm-deck-when">
            {stories[0] ? agoLabel(stories[0].takenAt, now) : "sem story"}
            {fresh > 0 && ` · ${fresh} ${fresh === 1 ? "novo" : "novos"}`}
          </div>
        </div>
        <span data-slot="count" className="sm-deck-count">{stories.length}</span>
      </div>
      <div className="sm-stack" style={{ "--n": top.length } as React.CSSProperties}>
        {top.map((story) => <StoryCard key={story.id} story={story} />)}
      </div>
      {fresh > 0 && <BorderBeam className="fx-border-beam" size={80} duration={4} borderWidth={1.5} colorFrom="var(--color-amber)" colorTo="var(--color-amber)" />}
    </article>
  );
}
