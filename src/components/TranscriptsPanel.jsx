import { useEffect, useState } from "react";
import { ChevronRight, Bookmark, BookmarkCheck, Trash2, FileText, Download, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const TKEY = "fbw_transcripts";
const SKEY = "fbw_saved";
const CKEY = "fbw_current";

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
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  a.click();
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

// ---- current in-view video (published by the content script) ----
function useCurrent() {
  const [cur, setCur] = useState(null);
  useEffect(() => {
    if (!hasStorage()) return;
    const load = () => chrome.storage.local.get(CKEY, (r) => setCur(r[CKEY] || null));
    load();
    const onChange = (c, area) => { if (area === "local" && c[CKEY]) setCur(c[CKEY].newValue || null); };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  return cur;
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

function CurrentVideoCard() {
  const cur = useCurrent();
  const [busy, setBusy] = useState(null); // "tx" | "dl" | null
  const run = (type, tag) => {
    if (!hasStorage()) return;
    setBusy(tag);
    chrome.runtime.sendMessage({ type });
    setTimeout(() => setBusy(null), 3000);
  };

  if (!cur) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-3 text-center text-[11px] text-muted-foreground leading-relaxed">
          Open a Facebook video and it shows up here —<br />then transcribe or download it.
        </CardContent>
      </Card>
    );
  }

  const c = cur.counts || {};
  const hasCounts = c.like || c.comment || c.share || c.views;
  return (
    <Card style={{ borderColor: "var(--sw-from)" }} className="border">
      <CardContent className="p-2.5 space-y-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--sw-from)" }}>
          Current video
        </div>
        <div className="flex gap-2.5">
          <div className="w-[52px] h-[78px] flex-none rounded-md overflow-hidden bg-zinc-800">
            {cur.thumb ? <img src={cur.thumb} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-foreground truncate">{cur.author?.name || "unknown"}</div>
            {cur.caption && <p className="text-[11px] text-foreground/70 mt-0.5 line-clamp-3 whitespace-pre-wrap">{cur.caption}</p>}
            {hasCounts && (
              <div className="flex gap-3 mt-1 text-[11px] text-muted-foreground">
                <span>👍 {c.like || "–"}</span><span>💬 {c.comment || "–"}</span><span>↗ {c.share || "–"}</span>
                {c.views && <span>👁 {c.views}</span>}
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => run("FBW_DO_TRANSCRIBE", "tx")}
            disabled={!!busy}
            className="flex-1 grad-blue text-white rounded-md py-1.5 text-[12px] font-medium flex items-center justify-center gap-1.5 disabled:opacity-70"
          >
            {busy === "tx" ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />} Transcribe
          </button>
          <button
            onClick={() => run("FBW_DO_DOWNLOAD", "dl")}
            disabled={!!busy}
            className="flex-1 rounded-md border border-border py-1.5 text-[12px] font-medium text-foreground hover:bg-muted flex items-center justify-center gap-1.5 disabled:opacity-70"
          >
            {busy === "dl" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---- card ----
function VideoCard({ it, saved, onToggleSave, onDelete }) {
  const [open, setOpen] = useState(false);
  const c = it.counts || {};
  const hasCounts = c.like || c.comment || c.share || c.views;
  const base = it.platform === "instagram" ? "https://www.instagram.com" : "https://www.facebook.com";
  const profUrl = it.author?.url ? `${base}${it.author.url.startsWith("/") ? "" : "/"}${it.author.url}` : null;
  const postUrl = it.platform === "instagram" ? `https://www.instagram.com/p/${it.videoId}/` : `https://www.facebook.com/${it.videoId}`;

  return (
    <Card>
      <CardContent className="p-2.5 space-y-2">
        <div className="flex gap-2.5">
          <div className="w-[56px] h-[84px] flex-none rounded-md overflow-hidden bg-zinc-800">
            {it.thumb ? <img src={it.thumb} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              {it.author?.name ? (
                <a href={profUrl || "#"} target="_blank" rel="noreferrer" className="text-[12px] font-semibold text-foreground hover:underline truncate">
                  {it.author.name}
                </a>
              ) : (
                <span className="text-[12px] text-muted-foreground">unknown</span>
              )}
              <div className="flex-none flex flex-col items-center gap-1.5">
                <button
                  onClick={onToggleSave}
                  title={saved ? "Remove from Saved" : "Save"}
                  className="text-muted-foreground hover:text-primary"
                >
                  {saved ? <BookmarkCheck size={15} className="text-primary" /> : <Bookmark size={15} />}
                </button>
                {onDelete && (
                  <button onClick={onDelete} title="Delete this transcript" className="text-muted-foreground hover:text-destructive">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>

            <a href={postUrl} target="_blank" rel="noreferrer" className="text-[10px] font-mono text-blue-500 hover:underline">
              #{it.videoId}
            </a>

            {it.caption && <p className="text-[11px] text-foreground/75 mt-1 line-clamp-3 whitespace-pre-wrap">{it.caption}</p>}

            {hasCounts && (
              <div className="flex gap-3 mt-1 text-[11px] text-muted-foreground">
                <span title="Likes">👍 {c.like || "–"}</span>
                <span title="Comments">💬 {c.comment || "–"}</span>
                <span title="Shares">↗ {c.share || "–"}</span>
                {c.views && <span title="Views">👁 {c.views}</span>}
              </div>
            )}

            {it.status === "error" && <p className="text-[11px] text-destructive mt-1">{it.error}</p>}

            {it.text && (
              <div className="flex gap-2 mt-1.5">
                <button className="text-[11px] text-blue-500 hover:underline" onClick={() => navigator.clipboard.writeText(it.text)}>copy</button>
                <button className="text-[11px] text-blue-500 hover:underline" onClick={() => dl(`fb-${it.videoId}.txt`, it.text)}>.txt</button>
                {it.chunks?.length ? <button className="text-[11px] text-blue-500 hover:underline" onClick={() => dl(`fb-${it.videoId}.srt`, srt(it.chunks))}>.srt</button> : null}
              </div>
            )}
          </div>
        </div>

        {it.text ? (
          <div>
            <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 w-full text-left text-[11px] font-medium text-foreground/80 hover:text-foreground">
              <ChevronRight size={13} className={`transition-transform ${open ? "rotate-90" : ""}`} />
              Transcript
            </button>
            {open && (
              <div className="mt-1.5 max-h-56 overflow-y-auto rounded-md bg-zinc-900 text-zinc-200 p-2.5 text-[12px] leading-relaxed whitespace-pre-wrap">
                {it.text}
              </div>
            )}
          </div>
        ) : it.status !== "error" ? (
          <div className="text-[11px] text-muted-foreground">transcribing…</div>
        ) : null}
      </CardContent>
    </Card>
  );
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
      <CurrentVideoCard />
      {items.length > 0 && (
        <>
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs font-medium text-foreground">{items.length} transcript{items.length > 1 ? "s" : ""}</span>
            <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => hasStorage() && chrome.storage.local.set({ [TKEY]: {} })}>clear all</button>
          </div>
          {items.map((it) => (
            <VideoCard
              key={it.videoId}
              it={it}
              saved={savedIds.has(it.videoId)}
              onToggleSave={() => toggleSave(it)}
              onDelete={() => patchMap(TKEY, it.videoId, null)}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ---- Saved tab (grouped: platform → page) ----
const PLATFORM_META = {
  facebook: { label: "Facebook", color: "#1877F2" },
  instagram: { label: "Instagram", color: "#E1306C" },
  tiktok: { label: "TikTok", color: "#111827" },
};

export function SavedPanel() {
  const saved = useStore(SKEY);
  const [collapsed, setCollapsed] = useState({}); // platform
  const [collapsedPages, setCollapsedPages] = useState({}); // "platform|page"

  if (!saved.length) {
    return (
      <div className="py-10 text-center text-xs text-muted-foreground">
        No saved videos yet.<br />Tap the <Bookmark size={12} className="inline -mt-0.5" /> on a transcript to save it here.
      </div>
    );
  }

  // group: platform → page name → items
  const groups = {};
  for (const it of saved) {
    const p = it.platform || "facebook";
    const page = it.author?.name || "Unknown";
    (groups[p] ||= {});
    (groups[p][page] ||= []).push(it);
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
        const pages = groups[p];
        const count = Object.values(pages).reduce((n, a) => n + a.length, 0);
        const open = !collapsed[p];
        return (
          <div key={p} className="space-y-2">
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [p]: !c[p] }))}
              className="flex w-full items-center gap-2 text-left"
            >
              <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
              <span className="text-sm font-semibold text-foreground">{meta.label}</span>
              <span className="text-[11px] text-muted-foreground">{count}</span>
            </button>

            {open &&
              Object.entries(pages)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([page, items]) => {
                  const pkey = `${p}|${page}`;
                  const pageOpen = !collapsedPages[pkey];
                  return (
                    <div key={page} className="ml-1.5 space-y-2 border-l border-border pl-2.5">
                      <button
                        onClick={() => setCollapsedPages((c) => ({ ...c, [pkey]: !c[pkey] }))}
                        className="flex w-full items-center gap-1.5 text-left"
                      >
                        <ChevronRight size={12} className={`transition-transform ${pageOpen ? "rotate-90" : ""}`} />
                        <span className="text-[11px] font-medium text-foreground/80">{page}</span>
                        <span className="text-[11px] text-muted-foreground opacity-70">({items.length})</span>
                      </button>
                      {pageOpen &&
                        items.map((it) => (
                          <VideoCard key={it.videoId} it={it} saved onToggleSave={() => patchMap(SKEY, it.videoId, null)} />
                        ))}
                    </div>
                  );
                })}
          </div>
        );
      })}
    </div>
  );
}
