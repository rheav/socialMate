import { useEffect, useState } from "react";
import { ChevronDown, Bookmark, BookmarkCheck, Trash2, ExternalLink } from "lucide-react";

const TKEY = "fbw_transcripts";
const SKEY = "fbw_saved";

const hasStorage = () => typeof chrome !== "undefined" && !!chrome?.storage?.local;

function srt(chunks) {
  const t = (s) => {
    const ms = Math.floor((s % 1) * 1000), x = Math.floor(s);
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${p(Math.floor(x / 3600))}:${p(Math.floor((x % 3600) / 60))}:${p(x % 60)},${p(ms, 3)}`;
  };
  return chunks
    .map((c, i) => `${i + 1}\n${t(c.timestamp?.[0] || 0)} --> ${t(c.timestamp?.[1] || (c.timestamp?.[0] || 0) + 2)}\n${(c.text || "").trim()}\n`)
    .join("\n");
}
function dl(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Free the blob once the download has been handed off.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- storage hooks ----
function useStore(key) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    if (!hasStorage()) return;
    const load = () =>
      chrome.storage.local.get(key, (r) => {
        const map = r[key] || {};
        setItems(Object.values(map).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
      });
    load();
    const onChange = (changes, area) => { if (area === "local" && changes[key]) load(); };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [key]);
  return items;
}
async function patchMap(key, id, value) {
  if (!hasStorage()) return;
  const r = await chrome.storage.local.get(key);
  const map = r[key] || {};
  if (value === null) delete map[id];
  else map[id] = { ...value, updatedAt: Date.now() };
  await chrome.storage.local.set({ [key]: map });
}

function useFlag(key) {
  const [val, setVal] = useState(false);
  useEffect(() => {
    if (!hasStorage()) return;
    const load = () => chrome.storage.local.get(key, (r) => setVal(!!r[key]));
    load();
    const onChange = (c, area) => { if (area === "local" && c[key]) setVal(!!c[key].newValue); };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [key]);
  return val;
}

function ReloadHint() {
  const needsReload = useFlag("fbw_need_reload");
  if (!needsReload) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg bg-amber-400/10 border border-amber-400/30 px-2.5 py-2 text-[11px] text-amber-700">
      <span className="flex-1">This tab isn’t linked yet — reload it to capture its video here.</span>
      <button
        className="flex-none rounded-md bg-amber-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-600"
        onClick={() => hasStorage() && chrome.runtime.sendMessage({ type: "FBW_RELOAD_TAB" })}
      >
        Reload tab
      </button>
    </div>
  );
}

// ---- grid tile: a big thumbnail on top, meta + transcript below ----
function VideoCard({ it, saved, onToggleSave, onDelete }) {
  const [open, setOpen] = useState(false);
  const c = it.counts || {};
  const hasCounts = c.like || c.comment || c.share || c.views;
  const base = it.platform === "instagram" ? "https://www.instagram.com" : "https://www.facebook.com";
  const profUrl = it.author?.url ? `${base}${it.author.url.startsWith("/") ? "" : "/"}${it.author.url}` : null;
  // Link back to the original reel/video: the stored sourceUrl, or reconstruct
  // one from the id for older records (FB reels key by their reel id).
  const srcUrl =
    it.sourceUrl ||
    (it.videoId
      ? it.platform === "instagram"
        ? `https://www.instagram.com/p/${it.videoId}/`
        : `https://www.facebook.com/reel/${it.videoId}`
      : null);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative aspect-[3/4] bg-zinc-900">
        {srcUrl ? (
          <a href={srcUrl} target="_blank" rel="noreferrer" title="Open the original reel" className="block h-full w-full">
            {it.thumb ? (
              <img src={it.thumb} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <div className="grid h-full w-full place-items-center text-[10px] text-zinc-500">open reel</div>
            )}
          </a>
        ) : it.thumb ? (
          <img src={it.thumb} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <div className="grid h-full w-full place-items-center text-[10px] text-zinc-500">no preview</div>
        )}
        {/* actions on the thumbnail */}
        <div className="absolute right-1.5 top-1.5 flex gap-1">
          {srcUrl && (
            <a
              href={srcUrl}
              target="_blank"
              rel="noreferrer"
              title="Open the original reel"
              className="grid size-6 place-items-center rounded-md bg-black/55 text-white backdrop-blur hover:bg-black/75"
            >
              <ExternalLink size={12} />
            </a>
          )}
          <button
            onClick={onToggleSave}
            title={saved ? "Remove from Saved" : "Save"}
            className="grid size-6 place-items-center rounded-md bg-black/55 text-white backdrop-blur hover:bg-black/75"
          >
            {saved ? <BookmarkCheck size={13} className="text-amber-400" /> : <Bookmark size={13} />}
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              title="Delete this transcript"
              className="grid size-6 place-items-center rounded-md bg-black/55 text-white backdrop-blur hover:bg-black/75"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        {/* counts strip */}
        {hasCounts && (
          <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-x-2 gap-y-0.5 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-4 text-[10px] font-medium text-white">
            {c.like && <span>👍 {c.like}</span>}
            {c.comment && <span>💬 {c.comment}</span>}
            {c.views && <span>👁 {c.views}</span>}
            {c.share && <span>↗ {c.share}</span>}
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-2">
        {it.author?.name ? (
          <a
            href={profUrl || "#"}
            target="_blank"
            rel="noreferrer"
            className="truncate text-[12px] font-semibold text-foreground hover:underline"
          >
            {it.author.name}
          </a>
        ) : (
          <span className="text-[12px] text-muted-foreground">unknown</span>
        )}

        {it.caption && (
          <p className="line-clamp-2 text-[11px] leading-snug text-foreground/70 whitespace-pre-wrap">
            {it.caption}
          </p>
        )}

        {it.status === "error" && <p className="text-[11px] text-destructive">{it.error}</p>}

        {it.text ? (
          <>
            <button
              onClick={() => setOpen((o) => !o)}
              className="mt-0.5 flex items-center gap-1 text-left text-[11px] font-medium text-foreground/80 hover:text-foreground"
            >
              <ChevronDown size={12} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
              Transcript
            </button>
            {open && (
              <div className="max-h-44 overflow-y-auto rounded-md bg-zinc-900 p-2 text-[11px] leading-relaxed text-zinc-200 whitespace-pre-wrap">
                {it.text}
              </div>
            )}
            <div className="mt-auto flex gap-2 pt-1 text-[11px]">
              <button className="text-primary hover:underline" onClick={() => navigator.clipboard.writeText(it.text)}>copy</button>
              <button className="text-primary hover:underline" onClick={() => dl(`fb-${it.videoId}.txt`, it.text)}>.txt</button>
              {it.chunks?.length ? (
                <button className="text-primary hover:underline" onClick={() => dl(`fb-${it.videoId}.srt`, srt(it.chunks))}>.srt</button>
              ) : null}
            </div>
          </>
        ) : it.status !== "error" ? (
          <div className="text-[11px] text-muted-foreground">transcribing…</div>
        ) : null}
      </div>
    </div>
  );
}

function Grid({ children }) {
  return <div className="grid grid-cols-2 gap-2.5">{children}</div>;
}

// ---- Transcripts tab ----
export default function TranscriptsPanel() {
  const items = useStore(TKEY);
  const saved = useStore(SKEY);
  const savedIds = new Set(saved.map((s) => s.videoId));

  const toggleSave = (it) => {
    if (savedIds.has(it.videoId)) patchMap(SKEY, it.videoId, null);
    else patchMap(SKEY, it.videoId, it);
  };

  return (
    <div className="space-y-2.5">
      <ReloadHint />
      {items.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground leading-relaxed">
          No transcripts yet.<br />
          Hit <span className="font-medium text-foreground">Transcribe</span> on a video in
          Facebook — it shows up here.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs font-medium text-foreground">{items.length} transcript{items.length > 1 ? "s" : ""}</span>
            <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => hasStorage() && chrome.storage.local.set({ [TKEY]: {} })}>clear all</button>
          </div>
          <Grid>
            {items.map((it) => (
              <VideoCard
                key={it.videoId}
                it={it}
                saved={savedIds.has(it.videoId)}
                onToggleSave={() => toggleSave(it)}
                onDelete={() => patchMap(TKEY, it.videoId, null)}
              />
            ))}
          </Grid>
        </>
      )}
    </div>
  );
}

// ---- Saved tab (grouped: platform → page, each a 2-col grid) ----
const PLATFORM_META = {
  facebook: { label: "Facebook", color: "#1877F2" },
  instagram: { label: "Instagram", color: "#E1306C" },
  tiktok: { label: "TikTok", color: "#111827" },
};

export function SavedPanel() {
  const saved = useStore(SKEY);
  const [collapsed, setCollapsed] = useState({});

  if (!saved.length) {
    return (
      <div className="py-10 text-center text-xs text-muted-foreground">
        No saved videos yet.<br />Tap the <Bookmark size={12} className="inline -mt-0.5" /> on a transcript to save it here.
      </div>
    );
  }

  const groups = {};
  for (const it of saved) {
    const p = it.platform || "facebook";
    (groups[p] ||= []).push(it);
  }
  const platforms = Object.keys(groups).sort();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">{saved.length} saved</span>
        <button className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1" onClick={() => hasStorage() && chrome.storage.local.set({ [SKEY]: {} })}>
          <Trash2 size={11} /> clear all
        </button>
      </div>

      {platforms.map((p) => {
        const meta = PLATFORM_META[p] || { label: p, color: "#888" };
        const items = groups[p];
        const open = !collapsed[p];
        return (
          <div key={p} className="space-y-2">
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [p]: !c[p] }))}
              className="flex w-full items-center gap-2 text-left"
            >
              <ChevronDown size={14} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
              <span className="text-sm font-semibold text-foreground">{meta.label}</span>
              <span className="text-[11px] text-muted-foreground">{items.length}</span>
            </button>
            {open && (
              <Grid>
                {items.map((it) => (
                  <VideoCard key={it.videoId} it={it} saved onToggleSave={() => patchMap(SKEY, it.videoId, null)} />
                ))}
              </Grid>
            )}
          </div>
        );
      })}
    </div>
  );
}
