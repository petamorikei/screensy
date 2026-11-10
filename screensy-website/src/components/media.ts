import type { RefObject } from "react";
import { useEffect } from "react";
import { applySpeaker } from "../devices.ts";

/**
 * Plays a stream in a media element: sets its source, its sound and its speaker, and plays it again whenever it
 * pauses, for example when React moves the element. onBlocked is called when the browser refuses to play sound before
 * a click on the page.
 */
export const useMediaPlayback = (
  ref: RefObject<HTMLMediaElement | null>,
  options: { stream: MediaStream | null; muted: boolean; speaker: string; onBlocked: () => void },
): void => {
  const { stream, muted, speaker, onBlocked } = options;

  useEffect(() => {
    const media = ref.current;

    if (media == null) {
      return;
    }

    if (media.srcObject !== stream) {
      media.srcObject = stream;
    }

    // The muted attribute only sets the initial state: the property mutes
    media.muted = muted;

    const play = () => {
      if (media.srcObject == null || !media.paused) {
        return;
      }

      media.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "NotAllowedError" && !media.muted) {
          onBlocked();
        }
      });
    };

    play();
    media.addEventListener("pause", play);
    return () => media.removeEventListener("pause", play);
  }, [ref, stream, muted, onBlocked]);

  useEffect(() => {
    if (ref.current != null) {
      void applySpeaker(ref.current, speaker);
    }
  }, [ref, speaker]);
};

/**
 * Calls back on the first click on the page while active, with the capture phase so that nothing stops it
 */
export const useFirstClick = (active: boolean, onClick: () => void): void => {
  useEffect(() => {
    if (!active) {
      return;
    }

    document.addEventListener("click", onClick, { capture: true, once: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, [active, onClick]);
};
