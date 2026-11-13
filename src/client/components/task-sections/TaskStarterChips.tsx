import { DS } from "../../design/tokens";
import { ChoiceButton } from "../../design/primitives";
import { useTaskStartersActions, useTaskStartersQuery } from "../../hooks/queries/useTaskStarters";
import type { TaskStarter } from "../../../shared/task-starters.js";

/** A task's suggested chats on its new-chat screen; tapping one puts its prompt in the composer. */
export function TaskStarterChips({
  taskId,
  onStart,
}: {
  taskId: string;
  /** Fills the composer; false when it didn't, so the suggestion stays. */
  onStart: (starter: TaskStarter) => boolean;
}) {
  const starters = useTaskStartersQuery(taskId).data?.starters ?? [];
  const { markUsed } = useTaskStartersActions(taskId);
  if (starters.length === 0) return null;
  return (
    <section aria-labelledby="task-starter-chips-label" className="space-y-2">
      <h3 id="task-starter-chips-label" className={DS.text.sectionLabel}>Suggested</h3>
      <div className={DS.choice.group}>
        {starters.map((starter) => (
          <ChoiceButton
            key={starter.id}
            title={starter.prompt}
            onClick={() => { if (onStart(starter)) markUsed(starter.id); }}
          >
            {starter.label}
          </ChoiceButton>
        ))}
      </div>
    </section>
  );
}
