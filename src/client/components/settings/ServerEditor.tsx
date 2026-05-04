import { useState } from "react";
import type { McpServerConfig } from "../../api";
import {
  getMcpServerTransport,
  isLocalMcpServerConfig,
  type LocalMcpServerConfig,
  type RemoteMcpServerConfig,
} from "../../../mcp-config";
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
  const [transport, setTransport] = useState(getMcpServerTransport(initialConfig));
  const [command, setCommand] = useState(
    isLocalMcpServerConfig(initialConfig) ? initialConfig.command : "",
  );
  const [argsText, setArgsText] = useState(
    isLocalMcpServerConfig(initialConfig) ? initialConfig.args.join("\n") : "",
  );
  const [url, setUrl] = useState(
    isLocalMcpServerConfig(initialConfig) ? "" : initialConfig.url,
  );
  const [toolsText, setToolsText] = useState(
    initialConfig.tools?.join(", ") ?? "*",
  );
  const [envText, setEnvText] = useState(
    isLocalMcpServerConfig(initialConfig) && initialConfig.env
      ? Object.entries(initialConfig.env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "",
  );
  const [headersText, setHeadersText] = useState(
    !isLocalMcpServerConfig(initialConfig) && initialConfig.headers
      ? Object.entries(initialConfig.headers)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      : "",
  );

  const normalizedName = name.trim();
  const existingNameSet = new Set(existingNames.map((existingName) => existingName.toLocaleLowerCase()));
  const nameError =
    normalizedName === ""
      ? "Name is required"
      : existingNameSet.has(normalizedName.toLocaleLowerCase())
        ? "Name already exists"
        : null;

  const commandError = transport === "local" && command.trim() === "" ? "Command is required" : null;
  const urlError = transport !== "local" && url.trim() === "" ? "URL is required" : null;

  const canSave = !nameError && !commandError && !urlError;

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
    const headers: Record<string, string> = {};
    for (const line of headersText.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        headers[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }

    if (transport === "local") {
      const cfg: LocalMcpServerConfig = { command: command.trim(), args };
      if (tools.length > 0) cfg.tools = tools;
      if (Object.keys(env).length > 0) cfg.env = env;
      onSave(cfg, name.trim());
      return;
    }

    const cfg: RemoteMcpServerConfig = { type: transport, url: url.trim() };
    if (tools.length > 0) cfg.tools = tools;
    if (Object.keys(headers).length > 0) cfg.headers = headers;
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

      <Field label="Transport">
        <select
          value={transport}
          onChange={(e) => setTransport(e.target.value as "local" | "http" | "sse")}
          className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none"
        >
          <option value="local">Local / stdio</option>
          <option value="http">Remote HTTP</option>
          <option value="sse">Remote SSE</option>
        </select>
      </Field>

      <Field
        label={transport === "local" ? "Command" : "URL"}
        error={transport === "local" ? commandError : urlError}
      >
        {transport === "local" ? (
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="e.g. npx, uvx, node"
            className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none"
          />
        ) : (
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none"
          />
        )}
      </Field>

      {transport === "local" ? (
        <>
          <Field label="Arguments (one per line)">
            <textarea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={"mcp\nremote\n--url\nhttps://..."}
              rows={4}
              className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none font-mono resize-y"
            />
          </Field>

          <Field label="Environment variables (KEY=VALUE, one per line)">
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder="API_KEY=abc123"
              rows={2}
              className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none font-mono resize-y"
            />
          </Field>
        </>
      ) : (
        <Field label="HTTP headers (KEY=VALUE, one per line)">
          <textarea
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            placeholder="Authorization=Bearer ..."
            rows={3}
            className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none font-mono resize-y"
          />
        </Field>
      )}

      {/* Tools */}
      <Field label="Tools filter (comma-separated)">
        <input
          value={toolsText}
          onChange={(e) => setToolsText(e.target.value)}
          placeholder="* (all tools)"
          className="w-full bg-bg-surface text-text-primary text-xs px-3 py-2 rounded-md border border-border focus:border-accent focus:outline-none"
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
