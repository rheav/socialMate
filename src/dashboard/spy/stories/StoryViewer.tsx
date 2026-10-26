import { useEffect, useRef } from "react";
import { X, ChevronLeft, ChevronRight, ExternalLink, Star } from "lucide-react";
import type { SpyCard, SpyStory } from "../../api";
import { useStoryMedia } from "./useStoryMedia";
import { useSpyDialog } from "../useSpyDialog";
import { accountName, durationLabel, hourLabel, instagramStoriesUrl } from "./storiesFormat";

// The only place a story plays. One <video> (or one <img> for a photo), muted
// and with controls, mounted while the overlay is open and gone with it. ← →
// move inside the account's list; Esc closes (useSpyDialog, like the sheet).
export function StoryViewer({
  stories,
  index,
  account,
  onIndex,
  onClose,
  onToggleStar,
}: {
  stories: SpyStory[];
  index: number;
  account: SpyCard;
  onIndex: (index: number) => void;
  onClose: () => void;
  onToggleStar?: (story: SpyStory) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useSpyDialog(true, ref, onClose);
  const story = stories[index];
  const mediaUrl = useStoryMedia(story?.id ?? "", "media");
  const posterUrl = useStoryMedia(story?.id ?? "", "poster");
  const hasPrev = index > 0;
  const hasNext = index < stories.length - 1;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "ArrowRight" && hasNext) { event.preventDefault(); onIndex(index + 1); }
      else if (event.key === "ArrowLeft" && hasPrev) { event.preventDefault(); onIndex(index - 1); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [index, hasPrev, hasNext, onIndex]);
  if (!story) return null;
  const dur = durationLabel(story.durationMs);
  return (
    <div className="sm-viewer">
      <button type="button" className="sm-viewer-backdrop" aria-label="Fechar o story" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Story" tabIndex={-1} className="sm-viewer-dialog">
        <div className="sm-viewer-top">
          <span className="sm-viewer-title">{accountName(account)}</span>
          <span className="sm-viewer-sub">{hourLabel(story.takenAt)}{dur && ` · ${dur}`} · {index + 1} de {stories.length}</span>
          {onToggleStar && (
            <button
              type="button"
              className={`sm-viewer-btn sm-viewer-star${story.starredAt != null ? " on" : ""}`}
              aria-label={story.starredAt != null ? "Desfavoritar" : "Favoritar"}
              aria-pressed={story.starredAt != null}
              title={story.starredAt != null ? "Favorito: nunca é apagado. Clique para desmarcar." : "Favoritar: nunca é apagado."}
              onClick={() => onToggleStar(story)}
            >
              <Star size={18} fill={story.starredAt != null ? "currentColor" : "none"} />
            </button>
          )}
          <button type="button" className="sm-viewer-btn" aria-label="Fechar" title="Fechar (Esc)" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="sm-viewer-stage">
          <button type="button" className="sm-viewer-nav" aria-label="Story anterior" disabled={!hasPrev} onClick={() => onIndex(index - 1)}><ChevronLeft size={22} /></button>
          {story.mediaType === 2 ? (
            <video
              key={story.id}
              src={mediaUrl}
              poster={posterUrl}
              controls
              playsInline
              muted
              autoPlay
              preload="metadata"
              className="sm-viewer-media"
            />
          ) : (
            <img key={story.id} src={mediaUrl} alt="" className="sm-viewer-media" />
          )}
          <button type="button" className="sm-viewer-nav" aria-label="Próximo story" disabled={!hasNext} onClick={() => onIndex(index + 1)}><ChevronRight size={22} /></button>
        </div>
        <div className="sm-viewer-meta">
          {story.links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer">🔗 {link.text ?? link.url}</a>
          ))}
          {story.music && <span>♪ {story.music.title}{story.music.artist && ` · ${story.music.artist}`}</span>}
          {story.aiLabel && <span>Conteúdo de IA</span>}
          {story.mentions.length > 0 && <span>@{story.mentions.join(" @")}</span>}
          {story.caption && <span>{story.caption}</span>}
          <a className="ml-auto" href={instagramStoriesUrl(account.key, story.id)} target="_blank" rel="noreferrer">
            <ExternalLink size={12} className="mr-1 inline" />Abrir no Instagram
          </a>
        </div>
      </div>
    </div>
  );
}
