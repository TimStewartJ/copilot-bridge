import { useId, useState } from "react";
import {
  isCustomAutopilot, MAX_AI_CREDITS, MAX_MINUTES, MIN_AI_CREDITS, MIN_MINUTES, type CustomAutopilot,
} from "../../../shared/send-mode.js";
import Dialog from "../../design/Dialog";
import { Button, FormRow, TextInput } from "../../design/primitives";
import { DS } from "../../design/tokens";

const MINUTE_PRESETS = [60, 120, 240, 480, 720, 1440];
const CREDIT_PRESETS = [2_500, 5_000, 10_000, 25_000, 50_000];

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes * 10) / 10} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function formatCredits(credits: number): string {
  return `${credits.toLocaleString("en-US")} AI ${credits === 1 ? "credit" : "credits"}`;
}

export function formatMinimums(mode: CustomAutopilot): string {
  return [
    mode.minMinutes !== undefined ? formatMinutes(mode.minMinutes) : undefined,
    mode.minAiCredits !== undefined ? formatCredits(mode.minAiCredits) : undefined,
  ].filter(Boolean).join(" + ");
}

export default function CustomAutopilotDialog({ value, comparing, running, pending = false, error, onApply, onClose }: {
  value?: CustomAutopilot;
  comparing?: boolean;
  /** Applies to the working run, counted from now, instead of the next prompt. */
  running?: boolean;
  pending?: boolean;
  error?: string;
  onApply: (value: CustomAutopilot) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [minutes, setMinutes] = useState(value?.minMinutes?.toString() ?? "");
  const [credits, setCredits] = useState(value?.minAiCredits?.toString() ?? "");
  const mode = {
    kind: "custom-autopilot",
    ...(minutes && { minMinutes: Number(minutes) }),
    ...(credits && { minAiCredits: Number(credits) }),
  };
  const valid = isCustomAutopilot(mode);
  return (
    <Dialog title="Custom Autopilot" pending={pending} onClose={onClose}>
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        if (isCustomAutopilot(mode)) onApply(mode);
      }}>
        <FormRow label="Minimum minutes" htmlFor={`${id}-minutes`}>
          <TextInput id={`${id}-minutes`} type="number" step="1" min={MIN_MINUTES} max={MAX_MINUTES}
            placeholder="Optional" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
          <div className="mt-2 flex flex-wrap gap-1.5" data-minimum-presets="minutes">
            {MINUTE_PRESETS.map((preset) => (
              <Button key={preset} size="sm" variant={minutes === String(preset) ? "primary" : "secondary"}
                onClick={() => setMinutes(minutes === String(preset) ? "" : String(preset))}>
                {formatMinutes(preset)}
              </Button>
            ))}
          </div>
        </FormRow>
        <FormRow label="Minimum AI credits" htmlFor={`${id}-credits`}>
          <TextInput id={`${id}-credits`} type="number" step="1" min={MIN_AI_CREDITS} max={MAX_AI_CREDITS}
            placeholder="Optional" value={credits} onChange={(event) => setCredits(event.target.value)} />
          <div className="mt-2 flex flex-wrap gap-1.5" data-minimum-presets="credits">
            {CREDIT_PRESETS.map((preset) => (
              <Button key={preset} size="sm" variant={credits === String(preset) ? "primary" : "secondary"}
                onClick={() => setCredits(credits === String(preset) ? "" : String(preset))}>
                {preset.toLocaleString("en-US")}
              </Button>
            ))}
          </div>
        </FormRow>
        {running && <p className={DS.text.meta}>Counts from now.</p>}
        {/* copy-ok: the reader can't guess the early end or the spend going over */}
        <p className={DS.text.meta}>Stops when every minimum is met or the agent runs out of work. Spend can go over.</p>
        {comparing && <p className={DS.text.meta}>No model comparison runs for this chat.</p>}
        {!valid && (minutes || credits) && <p role="alert" className={DS.tone.warning}>
          Use whole numbers: {formatMinutes(MIN_MINUTES)} to {formatMinutes(MAX_MINUTES)}, {MIN_AI_CREDITS} to {formatCredits(MAX_AI_CREDITS)}.
        </p>}
        {error && <p role="alert" className={DS.tone.danger}>{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!valid || pending}>{running ? "Apply now" : "Use for this prompt"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
