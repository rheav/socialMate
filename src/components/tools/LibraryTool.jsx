import { useState } from "react";
import { Bookmark, FileText } from "lucide-react";
import TabNav from "@/components/ui/TabNav";
import TranscriptsPanel, { SavedPanel } from "@/components/TranscriptsPanel";

// Global (cross-platform) library: captured transcripts + saved posts.
// Opens on Transcripts (the primary result of the on-page Transcribe button).
export default function LibraryTool() {
  const [tab, setTab] = useState("transcripts");
  return (
    <div className="space-y-3">
      <TabNav
        value={tab}
        onValueChange={setTab}
        tabs={[
          { id: "transcripts", label: "Transcripts", Icon: FileText },
          { id: "saved", label: "Saved", Icon: Bookmark },
        ]}
      />
      {tab === "transcripts" ? <TranscriptsPanel /> : <SavedPanel />}
    </div>
  );
}
