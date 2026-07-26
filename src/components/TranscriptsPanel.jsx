import { useEffect, useRef, useState } from "react";
import { ChevronDown, Bookmark, BookmarkCheck, Trash2, ExternalLink } from "lucide-react";
import { downloadPath } from "@/lib/downloadPath";
import { fmtCount } from "@/lib/igMedia";
import { sendBg } from "@/lib/bg";

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
// Transcript export. Was a synthetic <a download="…">, which always lands in the
// Downloads ROOT — Chrome flattens any path in that attribute into the file name
// (verified). chrome.downloads honours the folder, and the panel is a normal
// extension page so it can mint the blob URL itself.
function dl(platform, name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  chrome.downloads.download({
    url,
    filename: downloadPath(platform || "facebook", "transcript", name),
    saveAs: false,
    conflictAction: "uniquify",
  });
  // Free the blob once the download has been handed off.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Same prefixes the media downloaders already stamp on their files (ig-, tt-, pin-),
// so a transcript is recognisable as belonging to its video once both are on disk.
// `dl()` defaults an unknown platform to facebook, so this map does too.
const NAME_PREFIX = { facebook: "fb", instagram: "ig", tiktok: "tt", pinterest: "pin" };
const namePrefix = (platform) => NAME_PREFIX[platform] || "fb";

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
// Only for fbw_transcripts. Writes to fbw_saved go through the background
// (FBW_SAVED_TOGGLE / _REMOVE), which serializes them — this pane and a page
// overlay used to race each other with get→mutate→set.
async function patchMap(key, id, value) {
  if (!hasStorage()) return;
  const r = await chrome.storage.local.get(key);
  const map = r[key] || {};
  if (value === null) delete map[id];
  else map[id] = { ...value, updatedAt: Date.now() };
  await chrome.storage.local.set({ [key]: map });
}

// A transcript record doubles as a Library entry when the user stars it. It keeps
// its own shape (it carries text/chunks); the background merges rather than
// replaces, so starring never drops the transcript.
const toggleSavedEntry = (entry) =>
  sendBg({ type: "FBW_SAVED_TOGGLE", entry: { ...entry, updatedAt: Date.now() } });
const removeSavedEntry = (ids) => sendBg({ type: "FBW_SAVED_REMOVE", ids });

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
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-amber-400/10 border border-amber-400/30 px-2.5 py-2 text-[11px] text-amber-700">
      <span className="min-w-0 flex-1 break-words">Esta aba ainda não está vinculada — recarregue-a para capturar o vídeo aqui.</span>
      <button
        className="flex-none rounded-md bg-amber-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-600"
        onClick={() => hasStorage() && chrome.runtime.sendMessage({ type: "FBW_RELOAD_TAB" })}
      >
        Recarregar aba
      </button>
    </div>
  );
}

// ---- grid tile: a big thumbnail on top, meta + transcript below ----
function VideoCard({ it, saved, onToggleSave, onDelete }) {
  const [open, setOpen] = useState(false);
  // Counts are stored as raw numbers (schema 2) and formatted here. Records
  // written before that carry pre-formatted strings — pass those through.
  const n = (v) => (typeof v === "number" ? fmtCount(v) : v || null);
  const raw = it.counts || {};
  const c = {
    like: n(raw.like),
    comment: n(raw.comment),
    views: n(raw.views),
    share: n(raw.share),
  };
  const hasCounts = c.like || c.comment || c.share || c.views;
  const base = it.platform === "instagram" ? "https://www.instagram.com" : "https://www.facebook.com";
  // author.url comes in two shapes: FB/IG store a relative path (needs an origin
  // prepended above), while Pinterest/TikTok already store a full absolute URL —
  // prepending an origin to those would nest one URL inside another and produce a
  // dead link. Pass absolute URLs through unchanged.
  const isAbsolute = /^https?:\/\//.test(it.author?.url || "");
  const profUrl = it.author?.url ? (isAbsolute ? it.author.url : `${base}${it.author.url.startsWith("/") ? "" : "/"}${it.author.url}`) : null;
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
          <a href={srcUrl} target="_blank" rel="noreferrer" title="Abrir o reel original" className="block h-full w-full">
            {it.thumb ? (
              <img src={it.thumb} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <div className="grid h-full w-full place-items-center text-[10px] text-zinc-500">abrir reel</div>
            )}
          </a>
        ) : it.thumb ? (
          <img src={it.thumb} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <div className="grid h-full w-full place-items-center text-[10px] text-zinc-500">sem prévia</div>
        )}
        {/* actions on the thumbnail */}
        <div className="absolute right-1.5 top-1.5 flex gap-1">
          {srcUrl && (
            <a
              href={srcUrl}
              target="_blank"
              rel="noreferrer"
              title="Abrir o reel original"
              className="grid size-6 place-items-center rounded-md bg-black/70 text-white hover:bg-black/85"
            >
              <ExternalLink size={12} />
            </a>
          )}
          <button
            onClick={onToggleSave}
            title={saved ? "Remover dos salvos" : "Salvar"}
            className="grid size-6 place-items-center rounded-md bg-black/70 text-white hover:bg-black/85"
          >
            {saved ? <BookmarkCheck size={13} className="text-amber-400" /> : <Bookmark size={13} />}
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              title="Excluir esta transcrição"
              className="grid size-6 place-items-center rounded-md bg-black/70 text-white hover:bg-black/85"
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
          <span className="text-[12px] text-muted-foreground">desconhecido</span>
        )}

        {it.caption && (
          <p className="line-clamp-2 break-words text-[11px] leading-snug text-foreground/70 whitespace-pre-wrap">
            {it.caption}
          </p>
        )}

        {it.status === "error" && <p className="break-words text-[11px] text-destructive">{it.error}</p>}

        {it.text ? (
          <>
            <button
              onClick={() => setOpen((o) => !o)}
              className="mt-0.5 flex items-center gap-1 text-left text-[11px] font-medium text-foreground/80 hover:text-foreground"
            >
              <ChevronDown size={12} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
              Transcrição
            </button>
            {open && (
              <div className="max-h-44 overflow-y-auto rounded-md bg-zinc-900 p-2 text-[11px] leading-relaxed text-zinc-200 break-words whitespace-pre-wrap">
                {it.text}
              </div>
            )}
            <div className="mt-auto flex flex-wrap gap-x-2 gap-y-0.5 pt-1 text-[11px]">
              <button className="text-primary hover:underline" onClick={() => navigator.clipboard.writeText(it.text)}>copiar</button>
              <button className="text-primary hover:underline" onClick={() => dl(it.platform, `${namePrefix(it.platform)}-${it.videoId}.txt`, it.text)}>.txt</button>
              {it.chunks?.length ? (
                <button className="text-primary hover:underline" onClick={() => dl(it.platform, `${namePrefix(it.platform)}-${it.videoId}.srt`, srt(it.chunks))}>.srt</button>
              ) : null}
            </div>
          </>
        ) : it.status !== "error" ? (
          <div className="text-[11px] text-muted-foreground">transcrevendo…</div>
        ) : null}
      </div>
    </div>
  );
}

function Grid({ children }) {
  // grid-cols-2 holds at 260px (two ~106px tiles); the tiles' own content all
  // truncates or wraps, so nothing inside them pushes the page wider.
  return <div className="grid min-w-0 grid-cols-2 gap-2.5">{children}</div>;
}

// Wipes a whole store with no undo, so the first tap only arms the button and a
// second one commits. window.confirm is not an option: a native dialog belongs to
// the parent tab and would sit behind the side panel, unreachable.
function ClearAllButton({ onConfirm, className, children }) {
  const [armed, setArmed] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    // Capture phase, so a handler that stops propagation can't leave it armed.
    const disarm = (e) => { if (!ref.current?.contains(e.target)) setArmed(false); };
    document.addEventListener("pointerdown", disarm, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", disarm, true);
    };
  }, [armed]);

  return (
    <button
      ref={ref}
      title={armed ? "Toque de novo para confirmar" : undefined}
      className={
        armed
          ? "flex flex-none items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive"
          : className
      }
      onClick={() => {
        if (!armed) { setArmed(true); return; }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? <><Trash2 size={11} /> Confirmar?</> : children}
    </button>
  );
}

// ---- Transcripts tab ----
export default function TranscriptsPanel() {
  const items = useStore(TKEY);
  const saved = useStore(SKEY);
  const savedIds = new Set(saved.map((s) => s.videoId));

  const toggleSave = (it) => toggleSavedEntry(it);

  return (
    <div className="space-y-2.5">
      <ReloadHint />
      {items.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground leading-relaxed">
          Ainda não há transcrições.<br />
          Toque em <span className="font-medium text-foreground">Transcrever</span> em um vídeo no
          Facebook — ele aparece aqui.
        </p>
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-1">
            <span className="text-xs font-medium text-foreground">{items.length} {items.length === 1 ? "transcrição" : "transcrições"}</span>
            <ClearAllButton className="text-[11px] text-muted-foreground hover:text-foreground" onConfirm={() => hasStorage() && chrome.storage.local.set({ [TKEY]: {} })}>limpar tudo</ClearAllButton>
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
  pinterest: { label: "Pinterest", color: "#e60023" },
};

export function SavedPanel() {
  const saved = useStore(SKEY);
  const [collapsed, setCollapsed] = useState({});

  if (!saved.length) {
    return (
      <div className="py-10 text-center text-xs text-muted-foreground">
        Ainda não há vídeos salvos.<br />Toque no ícone <Bookmark size={12} className="inline -mt-0.5" /> em uma transcrição para salvá-la aqui.
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
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-foreground">{saved.length} {saved.length === 1 ? "salvo" : "salvos"}</span>
        <ClearAllButton className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1" onConfirm={() => removeSavedEntry(saved.map((x) => x.videoId))}>
          <Trash2 size={11} /> limpar tudo
        </ClearAllButton>
      </div>

      {platforms.map((p) => {
        const meta = PLATFORM_META[p] || { label: p, color: "#888" };
        const items = groups[p];
        const open = !collapsed[p];
        return (
          <div key={p} className="space-y-2">
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [p]: !c[p] }))}
              className="flex w-full min-w-0 items-center gap-2 text-left"
            >
              <ChevronDown size={14} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
              <span className="min-w-0 truncate text-sm font-semibold text-foreground">{meta.label}</span>
              <span className="text-[11px] text-muted-foreground">{items.length}</span>
            </button>
            {open && (
              <Grid>
                {items.map((it) => (
                  <VideoCard key={it.videoId} it={it} saved onToggleSave={() => removeSavedEntry(it.videoId)} />
                ))}
              </Grid>
            )}
          </div>
        );
      })}
    </div>
  );
}
