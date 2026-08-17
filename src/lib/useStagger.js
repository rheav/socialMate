import { useEffect, useRef, useState } from "react";

// Replays the grid's entrance stagger whenever `key` changes — a new sort, a
// new date range, a different surface. See `.sw-stagger` in index.css for the
// half of this that actually animates.
//
// The class it returns alternates between "sw-a" and "sw-b" rather than being
// added and removed. A CSS animation restarts on a change of animation-NAME (or
// on a remount), not on the same name being re-applied, and remounting is off
// the table here: the cards hold <img> thumbnails that would drop and re-fetch
// on every sort. Two names, alternated, replay the animation against the very
// same DOM nodes.
//
// A re-render that does NOT change `key` — a download finishing, a card being
// favourited — leaves the class alone, so a single card's status update cannot
// make the whole grid blink.
export default function useStagger(key) {
  const [pass, setPass] = useState(0);
  // The first run of the effect is the mount, where the class is already on the
  // element and the animation has already played. Flipping there would replay it
  // immediately, i.e. animate the grid in twice.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setPass((p) => p + 1);
  }, [key]);
  return "sw-stagger " + (pass % 2 ? "sw-b" : "sw-a");
}
