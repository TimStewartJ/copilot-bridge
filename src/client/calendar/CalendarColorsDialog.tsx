// Choosing the colour of each kind of event: the person's own, and each calendar they import from.
// The choice is saved on the server, so every device shows the same colours.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UNNAMED_SOURCE, type CalendarColor, type CalendarColors } from "../../shared/calendar";
import Dialog from "../design/Dialog";
import { FormRow, IdentityColorChoice, Notice } from "../design/primitives";
import { calendarRootKey, updateCalendarColors } from "./calendar-api";
import { sourceFilterLabel, sourceName } from "./calendar-ui";

export default function CalendarColorsDialog({ colors, onClose }: { colors: CalendarColors; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(colors);
  const [error, setError] = useState("");

  // Saving is quick and leaves the dialog usable, so it never blocks or steals focus from the swatches.
  async function save(change: { own?: CalendarColor; sources?: Record<string, CalendarColor> }) {
    setDraft((current) => ({ own: change.own ?? current.own, sources: { ...current.sources, ...change.sources } }));
    setError("");
    try {
      await updateCalendarColors(change);
      await queryClient.invalidateQueries({ queryKey: calendarRootKey });
    } catch (cause) {
      setDraft(colors);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <Dialog title="Event colors" pending={false} onClose={onClose}>
      <div className="space-y-4">
        <FormRow label="Added in Bridge">
          <IdentityColorChoice label="Color of events added in the Bridge" value={draft.own} onChange={(own) => void save({ own })} />
        </FormRow>
        {Object.keys(draft.sources).map((source) => (
          <FormRow key={source} label={sourceFilterLabel(source)}>
            <IdentityColorChoice label={source === UNNAMED_SOURCE ? "Color of imported events" : `Color of events from ${sourceName(source)}`} value={draft.sources[source]}
              onChange={(color) => void save({ sources: { [source]: color } })} />
          </FormRow>
        ))}
        {error && <Notice tone="danger" title="The color wasn't saved">{error}</Notice>}
      </div>
    </Dialog>
  );
}
