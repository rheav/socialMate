import WarmTool from "@/components/tools/WarmTool";

// Temporary shell during the swiss-knife migration: render the Warm tool for
// Facebook so the extraction is verifiable. Task 8 replaces this with <Shell/>.
export default function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex-1 px-4 py-3 space-y-3">
        <WarmTool platform="facebook" />
      </main>
    </div>
  );
}
