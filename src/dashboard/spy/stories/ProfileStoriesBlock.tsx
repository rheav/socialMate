import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import { api, isUnauthorized, type SpyCard, type SpyStory } from "../../api";
import { StoryCard } from "./StoryCard";
import "./stories.css";

// In the profile sheet, Instagram only: the switch that puts the account on
// the extension's stories passes, what the settings say about those passes,
// and the newest posters with the way to the Stories section.
export function ProfileStoriesBlock({
  profile,
  onProfileUpdate,
  onUnauthorized,
}: {
  profile: SpyCard;
  onProfileUpdate?: (profile: SpyCard) => void;
  onUnauthorized: () => void;
}) {
  const [on, setOn] = useState(profile.trackStories);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<{ passesPerDay: number; keepDays: number } | null>(null);
  const [recent, setRecent] = useState<SpyStory[] | null>(null);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => setOn(profile.trackStories), [profile.id, profile.trackStories]);
  useEffect(() => {
    api.spy.settings.get().then((s) => setSettings(s.stories)).catch((err) => { if (isUnauthorized(err)) onUnauthorized(); });
  }, [onUnauthorized]);
  useEffect(() => {
    inflight.current?.abort();
    if (!on) { setRecent(null); return; }
    const controller = new AbortController();
    inflight.current = controller;
    api.spy.stories.list("7d", profile.id, controller.signal)
      .then((list) => { if (!controller.signal.aborted) setRecent(list.stories.filter((s) => s.profileId === profile.id).slice(0, 6)); })
      .catch((err) => { if (!controller.signal.aborted && isUnauthorized(err)) onUnauthorized(); });
    return () => controller.abort();
  }, [on, profile.id, onUnauthorized]);

  async function toggle(next: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    setOn(next);
    try {
      const updated = await api.spy.updateProfile(profile.id, { trackStories: next });
      onProfileUpdate?.(updated);
    } catch (err) {
      setOn(!next);
      if (isUnauthorized(err)) onUnauthorized();
      else setError("Não consegui salvar. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-slot="profile-stories" className="space-y-2 rounded-xl border bg-card/40 p-3">
      <div className="flex items-center gap-3">
        {/* A pill that changes shape when it is on: the state reads at a glance. */}
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Trackear stories"
          disabled={saving}
          onClick={() => void toggle(!on)}
          className={`sm-track${on ? " on" : ""}`}
        >
          {on && <Check size={13} />}
          {on ? "Trackeando stories" : "Trackear stories"}
        </button>
        <span className="ml-auto text-xs text-muted-foreground">
          {settings ? `${settings.passesPerDay} ${settings.passesPerDay === 1 ? "passada" : "passadas"} por dia · guarda ${settings.keepDays} ${settings.keepDays === 1 ? "dia" : "dias"}` : ""}
        </span>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {!on ? (
        <p className="text-xs text-muted-foreground">Desligado. Os stories já guardados ficam até vencer.</p>
      ) : recent && recent.length > 0 ? (
        <>
          <div className="grid grid-cols-6 gap-2">
            {recent.map((story, i) => (
              <div key={story.id} className="fx-fade" style={{ "--i": i } as CSSProperties}><StoryCard story={story} /></div>
            ))}
          </div>
          <a href={`#spy/stories/${profile.id}`} className="inline-block text-xs text-primary hover:underline">ver todos →</a>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Nenhum story guardado ainda. A extensão passa nas próximas horas.</p>
      )}
    </div>
  );
}
