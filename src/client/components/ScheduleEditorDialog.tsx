import { useState } from "react";
import type { Schedule, ScheduleCreateInput } from "../api";
import { createSchedule, patchSchedule } from "../api";
import { X } from "lucide-react";

// ── Cron presets ──────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: "Every weekday at 8 AM", cron: "0 8 * * 1-5" },
  { label: "Every day at 8 AM", cron: "0 8 * * *" },
  { label: "Every day at 6 PM", cron: "0 18 * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 2 hours", cron: "0 */2 * * *" },
  { label: "Every 4 hours", cron: "0 */4 * * *" },
  { label: "Every Monday at 9 AM", cron: "0 9 * * 1" },
  { label: "Every Friday at 5 PM", cron: "0 17 * * 5" },
  { label: "Custom", cron: "" },
];

interface ScheduleEditorDialogProps {
  taskId: string;
  schedule: Schedule | null; // null = creating new
  onClose: () => void;
  onSaved: () => void;
}

export default function ScheduleEditorDialog({ taskId, schedule, onClose, onSaved }: ScheduleEditorDialogProps) {
  const isEditing = !!schedule;

  const [name, setName] = useState(schedule?.name ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [type, setType] = useState<"cron" | "once">(schedule?.type ?? "cron");
  const [cronExpr, setCronExpr] = useState(schedule?.cron ?? "0 8 * * 1-5");
  const [runAt, setRunAt] = useState(schedule?.runAt ? schedule.runAt.slice(0, 16) : ""); // datetime-local format
  const [reuseSession, setReuseSession] = useState(schedule?.reuseSession ?? false);
  const [maxRuns, setMaxRuns] = useState<string>(schedule?.maxRuns?.toString() ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track if using a preset or custom cron
  const currentPreset = CRON_PRESETS.find((p) => p.cron === cronExpr);
  const [selectedPreset, setSelectedPreset] = useState(
    currentPreset ? currentPreset.label : "Custom",
  );

  const handleSave = async () => {
    if (!name.trim() || !prompt.trim()) {
      setError("Name and prompt are required");
      return;
    }
    if (type === "cron" && !cronExpr.trim()) {
      setError("Cron expression is required");
      return;
    }
    if (type === "once" && !runAt) {
      setError("Run time is required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isEditing) {
        await patchSchedule(schedule!.id, {
          name: name.trim(),
          prompt: prompt.trim(),
          cron: type === "cron" ? cronExpr.trim() : undefined,
          runAt: type === "once" ? new Date(runAt).toISOString() : undefined,
          reuseSession,
          maxRuns: maxRuns ? parseInt(maxRuns, 10) : undefined,
        });
      } else {
        const input: ScheduleCreateInput = {
          taskId,
          name: name.trim(),
          prompt: prompt.trim(),
          type,
          ...(type === "cron" ? { cron: cronExpr.trim() } : { runAt: new Date(runAt).toISOString() }),
          reuseSession,
          ...(maxRuns ? { maxRuns: parseInt(maxRuns, 10) } : {}),
        };
        await createSchedule(input);
      }
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-bg-elevated border border-border rounded-xl shadow-2xl w-[420px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="text-sm font-semibold text-text-primary">
            {isEditing ? "Edit Schedule" : "New Schedule"}
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Name</label>
            <input
              autoFocus
              className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-2 text-text-primary outline-none focus:border-accent"
              placeholder="e.g. Daily standup prep"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Schedule type */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Type</label>
            <div className="flex gap-2">
              <button
                onClick={() => setType("cron")}
                className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${type === "cron" ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:border-text-faint"}`}
              >
                Recurring
              </button>
              <button
                onClick={() => setType("once")}
                className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${type === "once" ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:border-text-faint"}`}
              >
                One-time
              </button>
            </div>
          </div>

          {/* Timing */}
          {type === "cron" ? (
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Schedule</label>
              <select
                className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-2 text-text-primary outline-none focus:border-accent mb-2"
                value={selectedPreset}
                onChange={(e) => {
                  setSelectedPreset(e.target.value);
                  const preset = CRON_PRESETS.find((p) => p.label === e.target.value);
                  if (preset && preset.cron) setCronExpr(preset.cron);
                }}
              >
                {CRON_PRESETS.map((p) => (
                  <option key={p.label} value={p.label}>{p.label}</option>
                ))}
              </select>
              {(selectedPreset === "Custom" || !CRON_PRESETS.find((p) => p.label === selectedPreset)?.cron) && (
                <input
                  className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-2 text-text-primary outline-none focus:border-accent font-mono"
                  placeholder="0 8 * * 1-5"
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                />
              )}
              <div className="text-[10px] text-text-faint mt-1">
                Cron: {cronExpr || "—"}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Run at</label>
              <input
                type="datetime-local"
                className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-2 text-text-primary outline-none focus:border-accent"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
              />
            </div>
          )}

          {/* Prompt */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Prompt</label>
            <textarea
              className="w-full text-sm bg-bg-surface border border-border rounded-lg px-3 py-2 text-text-primary outline-none focus:border-accent resize-none"
              rows={4}
              placeholder="What should the agent do when this schedule fires?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          {/* Advanced */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-text-muted hover:text-text-primary transition-colors"
          >
            {showAdvanced ? "▾" : "▸"} Advanced
          </button>
          {showAdvanced && (
            <div className="space-y-3 pl-3 border-l-2 border-border">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="reuseSession"
                  checked={reuseSession}
                  onChange={(e) => setReuseSession(e.target.checked)}
                  className="rounded border-border"
                />
                <label htmlFor="reuseSession" className="text-xs text-text-muted">
                  Reuse last session (continue conversation)
                </label>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Max runs (optional)</label>
                <input
                  type="number"
                  min="1"
                  className="w-24 text-sm bg-bg-surface border border-border rounded-lg px-3 py-1.5 text-text-primary outline-none focus:border-accent"
                  placeholder="∞"
                  value={maxRuns}
                  onChange={(e) => setMaxRuns(e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-xs text-error bg-error/10 border border-error/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-xs font-medium bg-accent text-white hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? "Saving..." : isEditing ? "Save Changes" : "Create Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
