import { type ReactNode } from "react";
import type { Todo } from "../../api";
import TodoRow from "../TodoRow";
import CollapsibleCompleted from "../shared/CollapsibleCompleted";
import { Plus } from "lucide-react";

// ── Props ────────────────────────────────────────────────────────

export interface TaskTodoSectionProps {
  todos: Todo[];
  newTodoText: string;
  onNewTodoTextChange: (text: string) => void;
  onCreateTodo: (text: string) => Promise<void>;
  onTodoUpdate: (todo: Todo) => void;
  onTodoDelete: (id: string) => void;
  variant?: "panel" | "card";
  highlightId?: string | null;
}

// ── Component ────────────────────────────────────────────────────

export default function TaskTodoSection({
  todos,
  newTodoText,
  onNewTodoTextChange,
  onCreateTodo,
  onTodoUpdate,
  onTodoDelete,
  variant = "panel",
  highlightId,
}: TaskTodoSectionProps) {
  const openTodos = todos.filter((t) => !t.done);
  const doneTodos = todos.filter((t) => t.done);
  const isCard = variant === "card";

  return (
    <>
      {isCard ? (
        <div className="space-y-1">
          {openTodos.map((todo) => (
            <TodoRow
              key={todo.id}
              variant="card"
              todo={todo}
              onUpdate={onTodoUpdate}
              onDelete={() => onTodoDelete(todo.id)}
            />
          ))}
          {doneTodos.length > 0 && (
            <CollapsibleCompleted count={doneTodos.length}>
              <div className="pt-1 space-y-1">
                {doneTodos.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    variant="card"
                    todo={todo}
                    onUpdate={onTodoUpdate}
                    onDelete={() => onTodoDelete(todo.id)}
                  />
                ))}
              </div>
            </CollapsibleCompleted>
          )}
          <form
            className="flex items-center gap-2 px-3 py-1.5"
            onSubmit={async (e) => {
              e.preventDefault();
              const text = newTodoText.trim();
              if (!text) return;
              onNewTodoTextChange("");
              await onCreateTodo(text);
            }}
          >
            <Plus size={14} className="text-text-faint shrink-0" />
            <input
              type="text"
              value={newTodoText}
              onChange={(e) => onNewTodoTextChange(e.target.value)}
              placeholder="Add a to-do…"
              className="flex-1 text-sm bg-transparent border-none outline-none text-text-primary placeholder:text-text-faint"
            />
          </form>
        </div>
      ) : (
        <>
          {openTodos.length > 0 && (
            <div className="space-y-0">
              {openTodos.map((todo) => (
                <TodoRow
                  key={todo.id}
                  variant="panel"
                  todo={todo}
                  highlight={todo.id === highlightId}
                  onUpdate={onTodoUpdate}
                  onDelete={() => onTodoDelete(todo.id)}
                />
              ))}
            </div>
          )}
          {doneTodos.length > 0 && (
            <CollapsibleCompleted count={doneTodos.length}>
              <div className="space-y-0">
                {doneTodos.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    variant="panel"
                    todo={todo}
                    highlight={todo.id === highlightId}
                    onUpdate={onTodoUpdate}
                    onDelete={() => onTodoDelete(todo.id)}
                  />
                ))}
              </div>
            </CollapsibleCompleted>
          )}
          <div className="px-3 py-1">
            <input
              className="w-full text-xs bg-transparent border-none outline-none text-text-secondary placeholder:text-text-faint"
              placeholder="+ Add item…"
              value={newTodoText}
              onChange={(e) => onNewTodoTextChange(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && newTodoText.trim()) {
                  onNewTodoTextChange("");
                  await onCreateTodo(newTodoText.trim());
                }
              }}
            />
          </div>
        </>
      )}
    </>
  );
}
