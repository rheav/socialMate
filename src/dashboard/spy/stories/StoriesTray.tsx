import { cn } from "@/dashboard/lib/utils";
import type { SpyCard, SpyStoriesTrayEntry } from "../../api";
import { accountName, initialOf } from "./storiesFormat";

/** Avatar with the initial drawn by CSS, so a button's text stays the name alone. */
export function AccountAvatar({ profile, className }: { profile: SpyCard; className?: string }) {
  return profile.avatarUrl ? (
    <img src={profile.avatarUrl} alt="" loading="lazy" decoding="async" className={cn("sm-avatar", className)} referrerPolicy="no-referrer" />
  ) : (
    <span className={cn("sm-avatar", className)} data-initial={initialOf(profile)} aria-hidden="true" />
  );
}

// The tray at the top: "Todas", then one circle per account with stories in the
// period. The ring fills with what is on Instagram now (8 = full); the badge is
// the number of stories captured since the last visit.
export function StoriesTray({
  entries,
  profiles,
  selected,
  newCounts,
  onSelect,
}: {
  entries: SpyStoriesTrayEntry[];
  profiles: Map<string, SpyCard>;
  selected: string | null;
  newCounts: Map<string, number>;
  onSelect: (profileId: string | null) => void;
}) {
  return (
    <nav aria-label="Contas com stories" className="sm-tray">
      <button type="button" className={cn("sm-acc", selected === null && "on")} aria-pressed={selected === null} onClick={() => onSelect(null)}>
        <span className="sm-ring" style={{ "--seg": 100 } as React.CSSProperties}>
          <span className="sm-avatar sm-avatar-all" data-initial="∞" aria-hidden="true" />
        </span>
        <span className="sm-acc-name">Todas</span>
      </button>
      {entries.map((entry) => {
        const profile = profiles.get(entry.profileId);
        if (!profile) return null;
        const fresh = newCounts.get(entry.profileId) ?? 0;
        return (
          <button
            key={entry.profileId}
            type="button"
            className={cn("sm-acc", selected === entry.profileId && "on")}
            aria-pressed={selected === entry.profileId}
            onClick={() => onSelect(entry.profileId)}
            title={`${entry.count} ${entry.count === 1 ? "story" : "stories"}${fresh ? ` · ${fresh} novos` : ""}`}
          >
            <span className="sm-ring" style={{ "--seg": Math.min(100, Math.round((100 * entry.liveCount) / 8)) } as React.CSSProperties} data-new={fresh || undefined}>
              <AccountAvatar profile={profile} />
            </span>
            <span className="sm-acc-name">{accountName(profile)}</span>
          </button>
        );
      })}
    </nav>
  );
}
