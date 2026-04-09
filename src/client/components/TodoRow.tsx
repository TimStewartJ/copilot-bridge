import { useState, useEffect, useRef, useCallback } from "react";
import type { Todo, DashboardTodo } from "../api";
import { patchTodo, deleteTodo } from "../api";
import { deadlineUrgency, deadlineLabel, DEADLINE_STYLES, CHECKBOX_URGENCY } from "../todo-helpers";
import { GROUP_COLOR_BG, GROUP_COLOR_DOT } from "../group-colors";
import useLongPressMenu from "../hooks/useLongPressMenu";
import ContextMenu, { CtxItem, CtxDivider } from "./ContextMenu";
import {
  Check,
  Pencil,
  CalendarDays,
  CalendarX2,
  Trash2,
  ExternalLink,
  AlertTriangle,
  X,
} from "lucide-react";

// ── Variant-specific props ──────────────────────────────────────

interface BaseProps {
  todo: Todo | DashboardTodo;
  /** Called after patchTodo for edit/deadline/toggle (default behavior) */
  onUpdate: (todo: Todo) => void;
  /** Called after deleteTodo completes */
  onDelete: (id: string) => void;
  /** Whether deletion is allowed (default: true) */
  canDelete?: boolean;
  /** Override default toggle (patchTodo + onUpdate). Parent handles API + state. */
  onToggle?: () => void;
  /** Called on deadline change. If provided, replaces onUpdate for deadline changes. */
  onDeadlineChange?: (deadline: string | null) => void;
}

interface PanelVariantProps extends BaseProps {
  variant: "panel";
  /** Scroll-to and flash animation */
  highlight?: boolean;
}

interface DashboardVariantProps extends BaseProps {
  variant: "dashboard";
  /** Navigate to the todo's parent task */
  onSelectTask?: () => void;
  /** Hide the task name pill (e.g. when grouped by task) */
  hideTaskPill?: boolean;
}

interface CardVariantProps extends BaseProps {
  variant: "card";
}

type TodoRowProps = PanelVariantProps | DashboardVariantProps | CardVariantProps;

// ── Helper to check if todo is DashboardTodo ────────────────────

function isDashboardTodo(todo: Todo | DashboardTodo): todo is DashboardTodo {
  return "taskTitle" in todo;
}

// ── Component ───────────────────────────────────────────────────

export default function TodoRow(props: TodoRowProps) {
  const { todo, onUpdate, onDelete, canDelete = true, variant } = props;
  const highlight = variant === "panel" ? props.highlight : false;

  const dateRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const urgency = deadlineUrgency(todo.deadline, todo.done);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(todo.text);

  // Context menu
  const { bind, menu, closeMenu } = useLongPressMenu<string>();

  // Scroll into view on highlight
  useEffect(() => {
    if (highlight && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlight]);

  // Focus edit input
  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editing]);

  const commitEdit = useCallback(async () => {
    const trimmed = editText.trim();
    setEditing(false);
    if (!trimmed || trimmed === todo.text) {
      setEditText(todo.text);
      return;
    }
    const snapshot = { ...todo } as Todo;
    onUpdate({ ...todo, text: trimmed } as Todo);
    try {
      await patchTodo(todo.id, { text: trimmed });
    } catch {
      onUpdate(snapshot);
    }
  }, [editText, todo, onUpdate]);

  const handleToggle = useCallback(async () => {
    if (props.onToggle) {
      props.onToggle();
    } else {
      const snapshot = { ...todo } as Todo;
      onUpdate({ ...todo, done: !todo.done } as Todo);
      try {
        await patchTodo(todo.id, { done: !todo.done });
      } catch {
        onUpdate(snapshot);
      }
    }
  }, [todo, onUpdate, props.onToggle]);

  const handleDelete = useCallback(async () => {
    onDelete(todo.id);
    try {
      await deleteTodo(todo.id);
    } catch {
      // Deletion failed; next refetch will restore the item
    }
  }, [todo.id, onDelete]);

  const handleSetDeadline = useCallback(() => {
    try { dateRef.current?.showPicker(); } catch { dateRef.current?.click(); }
  }, []);

  const handleClearDeadline = useCallback(async () => {
    const prevDeadline = todo.deadline;
    if (props.onDeadlineChange) {
      props.onDeadlineChange(null);
    } else {
      onUpdate({ ...todo, deadline: undefined } as Todo);
    }
    try {
      await patchTodo(todo.id, { deadline: null });
    } catch {
      if (props.onDeadlineChange) {
        props.onDeadlineChange(prevDeadline ?? null);
      } else {
        onUpdate({ ...todo } as Todo);
      }
    }
  }, [todo, onUpdate, props.onDeadlineChange]);

  const handleDateChange = useCallback(async (val: string | null) => {
    const prevDeadline = todo.deadline;
    if (props.onDeadlineChange) {
      props.onDeadlineChange(val);
    } else {
      onUpdate({ ...todo, deadline: val ?? undefined } as Todo);
    }
    try {
      await patchTodo(todo.id, { deadline: val });
    } catch {
      if (props.onDeadlineChange) {
        props.onDeadlineChange(prevDeadline ?? null);
      } else {
        onUpdate({ ...todo } as Todo);
      }
    }
  }, [todo, onUpdate, props.onDeadlineChange]);

  const startEdit = useCallback(() => {
    if (!todo.done) {
      setEditText(todo.text);
      setEditing(true);
    }
  }, [todo.done, todo.text]);

  // Dashboard-specific data
  const dashTodo = isDashboardTodo(todo) ? todo : null;
  const onSelectTask = variant === "dashboard" ? props.onSelectTask : undefined;
  const hideTaskPill = variant === "dashboard" ? props.hideTaskPill : false;

  // Variant-specific styling
  const isPanel = variant === "panel";
  const isDashboard = variant === "dashboard";
  const isCard = variant === "card";

  const rowClass = isPanel
    ? `flex items-start gap-1.5 px-3 py-1 group hover:bg-bg-hover rounded-md transition-colors ${highlight ? "animate-todo-highlight" : ""}`
    : isDashboard
      ? "flex items-start gap-2.5 px-4 py-2.5 hover:bg-bg-hover transition-colors first:rounded-t-lg last:rounded-b-lg group"
      : "flex items-start gap-2 px-3 py-2 rounded-md bg-bg-surface group";

  const textClass = isPanel
    ? `text-xs break-words ${todo.done ? "text-text-faint line-through" : "text-text-secondary"}`
    : `text-sm break-words ${todo.done ? "text-text-faint line-through" : "text-text-primary"}`;

  const checkboxSize = isPanel ? "w-3.5 h-3.5" : "w-3.5 h-3.5";
  const checkIconSize = 9;

  // Row click: in panel/card, noop (handled by context menu); in dashboard, navigate
  const rowClick = isDashboard ? onSelectTask : undefined;

  return (
    <>
      <div
        ref={rowRef}
        data-todo-id={todo.id}
        className={rowClass}
        {...bind(todo.id, () => rowClick?.())}
      >
        {/* Checkbox */}
        <button
          onClick={async (e) => {
            e.stopPropagation();
            await handleToggle();
          }}
          className={`mt-0.5 ${checkboxSize} rounded border flex items-center justify-center shrink-0 transition-colors ${
            todo.done
              ? "bg-success/80 border-success/80 text-white hover:bg-success/60"
              : CHECKBOX_URGENCY[urgency]
          }`}
          title={todo.done ? "Mark incomplete" : "Mark complete"}
        >
          {todo.done && <Check size={checkIconSize} strokeWidth={3} />}
        </button>

        {/* Content */}
        <div
          className={`flex-1 min-w-0 ${isDashboard && onSelectTask ? "cursor-pointer" : ""}`}
          role={isDashboard && onSelectTask ? "button" : undefined}
        >
          {editing ? (
            <input
              ref={editRef}
              type="text"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") { setEditText(todo.text); setEditing(false); }
              }}
              className={`w-full bg-transparent border-b border-accent outline-none py-0 ${
                isPanel ? "text-xs text-text-secondary" : "text-sm text-text-primary"
              }`}
            />
          ) : (
            <span
              onClick={(e) => {
                if (!isDashboard && !todo.done) {
                  e.stopPropagation();
                  startEdit();
                }
              }}
              className={`${textClass} ${!isDashboard && !todo.done ? "cursor-text" : ""}`}
            >
              {todo.text}
            </span>
          )}

          {/* Sub-line: deadline + task pill (dashboard) */}
          {!editing && (
            <div className={`flex items-center gap-2 ${isDashboard ? "text-xs mt-0.5" : isPanel ? "" : "mt-0.5"}`}>
              {/* Task pill (dashboard only) */}
              {isDashboard && dashTodo?.taskTitle && !hideTaskPill && (
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] truncate max-w-[150px] ${
                  dashTodo.taskGroupColor
                    ? `${GROUP_COLOR_BG[dashTodo.taskGroupColor] ?? ""} text-text-secondary`
                    : "bg-bg-hover text-text-faint"
                }`}>
                  {dashTodo.taskGroupColor && (
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${GROUP_COLOR_DOT[dashTodo.taskGroupColor] ?? ""}`} />
                  )}
                  {dashTodo.taskTitle}
                </span>
              )}

              {/* Deadline badge */}
              {todo.deadline && !todo.done && (
                isPanel ? (
                  <span
                    className={`inline-flex items-center gap-0.5 ml-1.5 px-1 py-0.5 -my-0.5 rounded text-[10px] ${DEADLINE_STYLES[urgency]}`}
                  >
                    {urgency === "overdue" && "⚠ "}{deadlineLabel(todo.deadline)}
                  </span>
                ) : (
                  <span className={`shrink-0 flex items-center gap-0.5 ${
                    isCard ? "text-[10px]" : ""
                  } ${
                    urgency === "overdue" ? "text-error" : urgency === "soon" ? "text-warning" : "text-text-faint"
                  }`}>
                    {urgency === "overdue" && <AlertTriangle size={10} />}
                    {deadlineLabel(todo.deadline)}
                  </span>
                )
              )}
            </div>
          )}
        </div>

        {/* Hidden date input */}
        <input
          ref={dateRef}
          type="date"
          className="sr-only"
          tabIndex={-1}
          value={todo.deadline ?? ""}
          onChange={async (e) => {
            const val = e.target.value || null;
            await handleDateChange(val);
          }}
        />
      </div>

      {/* Context menu */}
      {menu && (
        <ContextMenu position={menu} onClose={closeMenu}>
          {!todo.done && (
            <CtxItem
              icon={<Pencil size={14} />}
              label="Edit"
              onClick={() => { closeMenu(); startEdit(); }}
            />
          )}
          <CtxItem
            icon={<CalendarDays size={14} />}
            label="Set deadline"
            onClick={() => { closeMenu(); handleSetDeadline(); }}
          />
          {todo.deadline && (
            <CtxItem
              icon={<CalendarX2 size={14} />}
              label="Clear deadline"
              onClick={() => { closeMenu(); handleClearDeadline(); }}
            />
          )}
          {isDashboard && onSelectTask && (
            <>
              <CtxDivider />
              <CtxItem
                icon={<ExternalLink size={14} />}
                label="Go to task"
                onClick={() => { closeMenu(); onSelectTask(); }}
              />
            </>
          )}
          {canDelete && (
            <>
              <CtxDivider />
              <CtxItem
                icon={<Trash2 size={14} />}
                label="Delete"
                className="text-error"
                onClick={() => { closeMenu(); handleDelete(); }}
              />
            </>
          )}
        </ContextMenu>
      )}
    </>
  );
}
