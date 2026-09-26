import Shell from "@/components/Shell";
import { initDownloadPrefs } from "@/lib/downloadPath";

// The panel downloads its own spreadsheets, transcripts and ZIPs directly — it is
// the only context that can mint a blob URL — so it needs the same primed copy of
// the folder settings the service worker keeps. Module scope, not an effect: a
// path builder can run before the first paint.
initDownloadPrefs();

export default function App() {
  return <Shell />;
}
