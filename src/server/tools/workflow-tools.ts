import type { AppContext } from "../app-context.js";
import { toolFailure } from "../tool-results.js";
import { defineSessionBridgeTool, registerBridgeToolDefinitions } from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { NO_PLAYBOOK, isPlaybookName } from "../../shared/workflow-vocabulary.js";
import { readSkill } from "../skills-registry.js";
import { homedir } from "node:os";
import { join } from "node:path";

/** Keeps a playbook and its extensions from flooding the conversation. */
const MAX_STEPS_CHARS = 24_000;

export interface RegisterWorkflowToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createWorkflowToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
    defineSessionBridgeTool("playbook_select", {
      description:
        "Record which playbook this chat follows, after matching the user's request to a playbook skill (description starting \"Playbook:\"). " +
        "The user sees it as a chip on the chat and can change it. Use \"none\" for a small, fully specified request that takes the direct path. A request to resume or finish earlier work selects pickup first, which then hands over to the playbook for the remaining work. " +
        "The result contains the playbook's steps (and steps this machine adds to it): copy them into your todo list and follow them. " +
        "Call it again with the same name to get the steps back, or with another name when a new task in the same chat needs a different playbook.",
      parameters: {
        type: "object",
        properties: {
          playbook: { type: "string", description: "Playbook skill name, such as \"bug-fix\" or \"research\", or \"none\"." },
          reason: { type: "string", description: "One sentence: why this playbook fits the request." },
        },
        required: ["playbook"],
      },
      handler: async (args: any, invocation: any) => {
        const name = typeof args.playbook === "string" ? args.playbook.trim() : "";
        if (!name || (name !== NO_PLAYBOOK && !isPlaybookName(name))) return toolFailure("playbook must be a playbook skill name or \"none\"");
        const catalog = ctx.skillCatalog;
        const playbook = name === NO_PLAYBOOK ? undefined : catalog?.findPlaybook(name);
        if (name !== NO_PLAYBOOK && !playbook) {
          const installed = catalog?.playbooks().map((candidate) => candidate.id).sort().join(", ");
          return toolFailure(`"${name}" is not an installed playbook.${installed ? ` Installed: ${installed}.` : ""}`);
        }
        const previous = ctx.sessionManager.getSessionPlaybook(invocation.sessionId);
        // A direct answer inside a chat the user, its task or its schedule set to a playbook covers this request only.
        if (name === NO_PLAYBOOK && previous?.playbook && previous.playbook !== NO_PLAYBOOK && previous.source !== "agent") {
          return {
            success: true,
            playbook: NO_PLAYBOOK,
            message: `Taking the direct path for this request. The chat stays on ${previous.label ?? previous.playbook}, which ${previous.source === "user" ? "the user" : `its ${previous.source}`} chose.`,
          };
        }
        // Asking again for the active playbook only fetches its steps; who chose it stays as it was.
        let view = previous?.playbook === name ? previous : undefined;
        if (!view) {
          try {
            view = await ctx.sessionManager.setSessionPlaybook(invocation.sessionId, name, "agent");
          } catch (error) {
            return toolFailure(error instanceof Error ? error.message : String(error));
          }
        }
        if (name === NO_PLAYBOOK) {
          return { success: true, playbook: NO_PLAYBOOK, message: "Recorded the direct path for this request." };
        }
        const skillOptions = {
          copilotHome: ctx.copilotHome ?? ctx.runtimePaths?.copilotHome ?? join(homedir(), ".copilot"),
          packs: ctx.skillPacks?.activeRoots(undefined, { ignoreTags: true }) ?? [],
        };
        const extensions = (catalog?.current() ?? []).filter((skill) => skill.extends.includes(name)).map((skill) => skill.id);
        const [main, ...added] = await Promise.all([name, ...extensions].map((id) => readSkill(skillOptions, id)));
        if (!main) return toolFailure(`The playbook "${name}" could not be read.`);
        for (const id of [name, ...extensions]) ctx.skillUsageStore?.record(id, invocation.sessionId);
        let steps = [
          `# Playbook: ${view.label ?? name}`,
          main.body,
          ...added.flatMap((skill) => skill ? [`# Added on this machine by ${skill.id}`, skill.body] : []),
        ].join("\n\n");
        if (steps.length > MAX_STEPS_CHARS) steps = `${steps.slice(0, MAX_STEPS_CHARS)}\n[truncated: load the rest with the skill tool]`;
        const required = playbook?.evidence ?? [];
        // The completion check is the last item on every playbook's todo list, so it is never left in a footnote.
        steps += `\n\n# Final step (required)\nBefore your final reply, call verify_complete with the evidence "Done means" describes${required.length > 0 ? ` (it must include ${required.join(", ")})` : ""}. Report results honestly: "pass" when a check supports the work you report (a reproduced bug is pass, and so is a premise you checked and found false), "fail" only when your own work failed a check, "not_run" for an in-scope check you could not run. List in-scope checks you skipped in unverified, and caveats outside what was asked in notes.`;
        const replacedUserChoice = previous?.source === "user" && previous.playbook && previous.playbook !== name
          ? ` The user had chosen ${previous.label ?? previous.playbook}; tell them you switched and why.`
          : "";
        return {
          success: true,
          playbook: name,
          label: view.label,
          requiredEvidence: required,
          ...(extensions.length > 0 ? { extensions } : {}),
          message: `Recorded ${view.label ?? name}. Copy the steps below into your todo list now and follow them in order; mark a step you skip "skip: <reason>". When they are done, call verify_complete${required.length > 0 ? ` with evidence of kind ${required.join(", ")}` : ""}.${replacedUserChoice}`,
          steps,
        };
      },
    }),
  ];
}

export function registerWorkflowTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterWorkflowToolsOptions = {},
): void {
  const definitions = createWorkflowToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
