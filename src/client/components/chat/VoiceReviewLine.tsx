import { useEffect, useRef, useState } from "react";
import { voiceJobRecordingUrl } from "../../api";
import { describeVoiceReview, type VoiceReviewNotice } from "../../lib/voice-review";
import { DS, cx } from "../../design/tokens";

/** The line above the composer while a dictation waits for review, with its recording when there is one. */
export function VoiceReviewLine({ review }: { review: VoiceReviewNotice }) {
  // The composer stays mounted between chats, and one chat's playback must not carry into the next.
  return <ReviewLine key={review.recordingJobId ?? "no-recording"} review={review} />;
}

function ReviewLine({ review }: { review: VoiceReviewNotice }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => () => audioRef.current?.pause(), []);

  const toggle = () => {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }
    setFailed(false);
    if (!audioRef.current) {
      const audio = new Audio(voiceJobRecordingUrl(review.recordingJobId!));
      audio.onended = () => setPlaying(false);
      audio.onerror = () => { setPlaying(false); setFailed(true); };
      // Start just before the possible gap: a long recording is otherwise a long wait to reach it.
      if (review.reason === "coverage" && review.gapStartSeconds) {
        audio.currentTime = Math.max(0, review.gapStartSeconds - 1);
      }
      audioRef.current = audio;
    }
    setPlaying(true);
    void audioRef.current.play().catch(() => { setPlaying(false); setFailed(true); });
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 px-1 text-xs text-warning" data-voice-review={review.reason}>
      <span role="status" aria-live="polite">{describeVoiceReview(review.reason)}</span>
      {review.recordingJobId && (
        <button
          type="button"
          onClick={toggle}
          className={cx("rounded-sm font-medium underline underline-offset-2 transition-colors hover:text-text-primary", DS.focus)}
        >
          {playing ? "Stop" : "Play recording"}
        </button>
      )}
      {failed && <span className="text-error">The recording couldn't be played.</span>}
    </div>
  );
}
