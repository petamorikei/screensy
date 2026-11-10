import { useAtomValue } from "jotai";
import { useCallback, useRef, useState } from "react";
import { showNotice } from "../notices.tsx";
import { callAtom, devicesAtom } from "../state/atoms.ts";
import { useFirstClick, useMediaPlayback } from "./media.ts";

const CallStream = (props: { stream: MediaStream; muted: boolean; speaker: string; onBlocked: () => void }) => {
  const audio = useRef<HTMLAudioElement>(null);
  useMediaPlayback(audio, props);
  // Muted until the effect sets the sound, so that it never plays before
  return <audio ref={audio} data-testid="call-audio" muted />;
};

/**
 * Plays the call: one hidden <audio> per received stream. If the browser refuses sound before a click on the page,
 * it says so once, and plays again on the first click.
 */
export const CallAudio = () => {
  const call = useAtomValue(callAtom);
  const speaker = useAtomValue(devicesAtom).choice.speaker;
  const [blocked, setBlocked] = useState(false);
  const notified = useRef(false);

  const onBlocked = useCallback(() => {
    if (!notified.current) {
      notified.current = true;
      showNotice("call-audio-blocked");
    }

    setBlocked(true);
  }, []);
  const onFirstClick = useCallback(() => {
    notified.current = false;
    setBlocked(false);
  }, []);
  useFirstClick(blocked, onFirstClick);

  return (
    <div hidden>
      {call.audio.map((entry) => (
        <CallStream
          key={entry.key}
          stream={entry.stream}
          // Muted while blocked, so that the element waits for the click without failing again
          muted={call.audioMuted || blocked}
          speaker={speaker}
          onBlocked={onBlocked}
        />
      ))}
    </div>
  );
};
