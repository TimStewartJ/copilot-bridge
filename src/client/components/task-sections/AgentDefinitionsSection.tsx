import { Bot } from "lucide-react";
import type { TaskAgentDefinitionSummary } from "../../api";
import TaskPanelSummaryDisclosure from "../TaskPanelSummaryDisclosure";
import { UI } from "../shared/design-system";

export interface AgentDefinitionsSectionProps {
  taskId: string;
  definitions: TaskAgentDefinitionSummary[];
  onPreview: (definition: TaskAgentDefinitionSummary) => void;
}

export default function AgentDefinitionsSection({
  taskId,
  definitions,
  onPreview,
}: AgentDefinitionsSectionProps) {
  if (definitions.length === 0) return null;
  const primary = definitions[0];

  return (
    <TaskPanelSummaryDisclosure
      label="Agents"
      icon={<Bot size={14} className="text-agent" />}
      title={definitions.length === 1
        ? primary.displayName ?? primary.name
        : `${definitions.length} attached agents`}
      subtitle={definitions.length === 1
        ? primary.description
        : "Available for delegation and new task chats"}
      subtitleClassName="line-clamp-2"
      chips={[
        {
          label: `${definitions.filter((definition) => definition.userInvocable).length} selectable`,
          className: UI.chip.muted,
        },
      ]}
      itemCount={definitions.length}
      taskId={taskId}
      disclosureId="agent-definitions"
      expandWhenSingle
    >
      {definitions.map((definition) => (
        <button
          key={definition.name}
          type="button"
          onClick={() => onPreview(definition)}
          className="block w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-bg-hover"
        >
          <div className="flex items-start gap-2">
            <Bot size={12} className="mt-0.5 shrink-0 text-agent" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-text-primary">
                {definition.displayName ?? definition.name}
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-text-faint">
                {definition.name}
              </div>
              <div className="mt-1 line-clamp-2 text-[11px] text-text-muted">
                {definition.description}
              </div>
            </div>
          </div>
        </button>
      ))}
    </TaskPanelSummaryDisclosure>
  );
}
