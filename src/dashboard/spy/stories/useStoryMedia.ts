import { useEffect, useState } from "react";
import { readStoryMedia } from "../../../hub-local/media.js";

/**
 * A story's media or poster as an object URL. The hub served these over HTTP; here
 * the bytes sit in the extension's IndexedDB, so the page reads them and revokes
 * the URL when the story leaves the screen.
 */
export function useStoryMedia(id: string, kind: "media" | "poster"): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let live = true;
    let made: string | undefined;
    setUrl(undefined);
    readStoryMedia(id, kind)
      .then((blob: Blob | null) => {
        if (!live || !blob) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id, kind]);
  return url;
}
