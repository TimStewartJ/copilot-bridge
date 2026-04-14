import { useState } from "react";
import type { McpServerConfig } from "../../api";
import { Field } from "./Field";

export function ServerEditor({
  name: initialName,
  config: initialConfig,
  existingNames,
  onSave,
  onCancel,
  isNew,
}: {
  name: string;
  config: McpServerConfig;
  existingNames: string[];
  onSave: (config: McpServerConfig, name?: string) => void;
  onCancel: () => void;
  isNew?: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [command, setCommand] = useState(initialConfig.command);
  const [argsText, setArgsText] = useState(initialConfig.args.join("\n"));
  const [toolsText, setToolsText] = useState(
    initialConfig.tools?.join(", ") ?? "*",
  );
  const [envText, setEnvText] = useState(
    initialConfig.env
      ? Object.entries(initialConfig.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "",
  );

  const nameError =
    name.trim() === ""
      ? "Name is required"
      : existingNames.includes(name.trim())
        ? "Name already exists"
        : null;

  const commandError = command.trim() === "" ? "Command is required" : null;

  const canSave = !nameError && !commandError;

  const handleSubmit = () => {
    if (!canSave) return;

    const args = argsText
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean);
    const tools = toolsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }

    const cfg: McpServerConfig = { command: command.trim(), args };
    if (tools.length > 0) cfg.tools = tools;
    if (Object.keys(env).length > 0) cfg.env = env;

    onSave(cfg, name.trim());
  };

  return (
    <div className="bg-bg-elevated border border-accent/20 rounded-md p-4 space-y-3">
      <div className="text-xs font-medium text-accent mb-2">
        {isNew ? "Add MCP Server" : `Edit: ${initialName}`}
      </div>

      {/* Name */}
      <Field label="Name" error={nameError}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. ado, github, filesystem"
          className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none"
          autoFocus={isNew}
        />
      </Field>

      {/* Command */}
      <Field label="Command" error={commandError}>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="e.g. npx, mcp-remote, node"
          className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none"
        />
      </Field>

      {/* Args */}
      <Field label="Arguments (one per line)">
        <textarea
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder={"mcp\nremote\n--url\nhttps://..."}
          rows={4}
          className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none font-mono resize-y"
        />
      </Field>

      {/* Tools */}
      <Field label="Tools filter (comma-separated)">
        <input
          value={toolsText}
          onChange={(e) => setToolsText(e.target.value)}
          placeholder="* (all tools)"
          className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none"
        />
      </Field>

      {/* Env */}
      <Field label="Environment variables (KEY=VALUE, one per line)">
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder="API_KEY=abc123"
          rows={2}
          className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none font-mono resize-y"
        />
      </Field>

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSave}
          className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${
            canSave
              ? "bg-accent text-white hover:bg-accent-hover"
              : "bg-bg-elevated text-text-faint cursor-not-allowed"
          }`}
        >
          {isNew ? "Add" : "Update"}
        </button>
      </div>
    </div>
  );
}
