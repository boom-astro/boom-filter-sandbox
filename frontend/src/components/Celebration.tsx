import { useEffect } from "react";
import { fireConfetti, SETTLE_DELAY_MS, type Celebration } from "@/lib/confetti";

/**
 * Fires the confetti once the object page is actually on screen.
 *
 * Renders nothing. Mount this *inside* the Suspense boundary that wraps the
 * page content: React won't mount it until the lazy chunk has resolved, and the
 * two nested rAFs then push the burst past the first real paint of that
 * content, with a short settle delay for charts and images to fill in.
 *
 * Unmounting (i.e. navigating away) tears down an in-flight show.
 */
export function Celebration({ celebration }: { celebration: Celebration }) {
  useEffect(() => {
    let dismiss: (() => void) | null = null;
    let inner = 0;
    let timer = 0;

    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        timer = window.setTimeout(() => {
          dismiss = fireConfetti(celebration);
        }, SETTLE_DELAY_MS);
      });
    });

    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      clearTimeout(timer);
      dismiss?.();
    };
  }, [celebration]);

  return null;
}
