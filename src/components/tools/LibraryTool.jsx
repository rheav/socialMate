import { useEffect, useState } from "react";
import { Bookmark, FileText, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import TabNav from "@/components/ui/TabNav";
import TranscriptsPanel, { SavedPanel } from "@/components/TranscriptsPanel";

// Global (cross-platform) library: saved posts, captured transcripts, run history.
export default function LibraryTool() {
  const [tab, setTab] = useState("saved");
  return (
    <div className="space-y-3">
      <TabNav
        value={tab}
        onValueChange={setTab}
        tabs={[
          { id: "saved", label: "Saved", Icon: Bookmark },
          { id: "transcripts", label: "Transcripts", Icon: FileText },
          { id: "history", label: "History", Icon: History },
        ]}
      />
      {tab === "saved" ? (
        <SavedPanel />
      ) : tab === "transcripts" ? (
        <TranscriptsPanel />
      ) : (
        <HistoryPanel />
      )}
    </div>
  );
}

function HistoryPanel() {
  const [hist, setHist] = useState([]);
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    chrome.storage.local
      .get("fbw_history")
      .then((r) =>
        setHist(
          Array.isArray(r?.fbw_history) ? r.fbw_history.slice().reverse() : [],
        ),
      );
  }, []);
  const clear = () => {
    chrome?.storage?.local?.set({ fbw_history: [] });
    setHist([]);
  };
  if (!hist.length)
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No runs yet. Start a warm session to log history here.
      </p>
    );
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs h-7"
          onClick={clear}
        >
          Clear
        </Button>
      </div>
      {hist.map((h, i) => {
        const ok = h.outcome === "complete";
        const halted = (h.outcome || "").startsWith("halt");
        return (
          <Card key={i}>
            <CardContent className="p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate">
                  {h.platform} · {h.keyword || h.mode}
                </span>
                <span
                  className={`text-[10px] rounded-full px-2 py-0.5 ${ok ? "bg-emerald-500/10 text-emerald-600" : halted ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}
                >
                  {ok ? "complete" : halted ? "halted" : "stopped"}
                </span>
              </div>
              {halted && (
                <p className="text-[11px] text-destructive">
                  {h.outcome.replace(/^halt:\s*/, "")}
                </p>
              )}
              <div className="flex gap-3 text-[11px] text-muted-foreground">
                <span>👍 {h.liked ?? 0}</span>
                <span>❤️ {h.loved ?? 0}</span>
                <span>seen {h.processed ?? 0}</span>
                <span>skip {h.skipped ?? 0}</span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                {new Date(h.at).toLocaleString()}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
