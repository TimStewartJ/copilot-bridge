import { useState } from "react";
import { Loader2, Moon } from "lucide-react";
import { hibernateDevice } from "../../api";
import { SettingsSection } from "./SettingsSection";

export function DeviceManagementSection() {
  const [hibernating, setHibernating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleHibernate = async () => {
    const confirmed = window.confirm(
      "Hibernate this device?\n\nCopilot Bridge and other apps will pause until the device wakes.",
    );
    if (!confirmed) return;

    setHibernating(true);
    setMessage(null);
    try {
      const result = await hibernateDevice();
      setMessage(result.message);
    } catch (error) {
      setMessage(`Hibernate failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setHibernating(false);
    }
  };

  return (
    <SettingsSection
      title="Device Management"
      description="Shortcuts for managing the device running this Copilot Bridge instance."
    >
      <div className="rounded-md border border-border bg-bg-elevated p-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-accent">
              <Moon size={15} />
              Hibernate device
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Put the host device into hibernation. Bridge resumes when the device wakes.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleHibernate()}
            disabled={hibernating}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-warning px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-warning/90 disabled:cursor-wait disabled:bg-bg-surface disabled:text-text-faint"
          >
            {hibernating ? <Loader2 size={12} className="animate-spin" /> : <Moon size={12} />}
            Hibernate
          </button>
        </div>

        {message && (
          <div className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-muted">
            {message}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
