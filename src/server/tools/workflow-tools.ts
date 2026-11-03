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
        "Switch when the requested outcome changes, not for a clarification or a quick aside. Calling again with the same name retrieves its steps. A delegated agent gets steps for its own assignment without changing the chat.",
      parameters: {
        type: "object",
        properties: {
          playbook: { type: "string", description: "Playbook skill name, such as \"bug-fix\" or \"research\", or \"none\"." },
          reason: { type: "string", description: "One sentence: why this playbook fits the request." },
          newOutcome: { type: "boolean", description: 'Only for "none": true when a new, small outcome replaces the previous work. Omit for a quick aside to keep the current playbook.' },
        },
        required: ["playbook"],
      },
      handler: async (args, invocation) => {
        const name = typeof args.playbook === "string" ? args.playbook.trim() : "";
        if (!name || (name !== NO_PLAYBOOK && !isPlaybookName(name))) return toolFailure("playbook must be a playbook skill name or \"none\"");
        const catalog = ctx.skillCatalog;
        const playbook = name === NO_PLAYBOOK ? undefined : catalog?.findPlaybook(name);
        if (name !== NO_PLAYBOOK && !playbook) {
          const installed = catalog?.playbooks().map((candidate) => candidate.id).sort().join(", ");
          return toolFailure(`"${name}" is not an installed playbook.${installed ? ` Installed: ${installed}.` : ""}`);
        }
        const delegated = !!invocation.agentId;
        const previous = delegated ? undefined : ctx.sessionManager.getSessionPlaybook(invocation.sessionId);
        if (name === NO_PLAYBOOK && previous?.playbook && previous.playbook !== NO_PLAYBOOK && args.newOutcome !== true) {
          return {
            success: true,
            playbook: NO_PLAYBOOK,
            message: `Taking the direct path for this request. The chat stays on ${previous.label ?? previous.playbook}.`,
          };
        }
        // Asking again for the active playbook only fetches its steps; who chose it stays as it was.
        let view = previous?.playbook === name ? previous : undefined;
        if (!delegated && !view) {
          try {
            view = await ctx.sessionManager.setSessionPlaybook(invocation.sessionId, name, "agent");
          } catch (error) {
            return toolFailure(error instanceof Error ? error.message : String(error));
          }
        }
        const replacedUserChoice = previous?.source === "user" && previous.playbook && previous.playbook !== name
          ? ` The user had chosen ${previous.label ?? previous.playbook}; tell them you switched and why.`
          : "";
        if (name === NO_PLAYBOOK) {
          const message = delegated ? "Taking the direct path for your assignment." : `Recorded the direct path.${replacedUserChoice}`;
          return { success: true, playbook: NO_PLAYBOOK, message };
        }
        const skillOptions = {
          copilotHome: ctx.copilotHome ?? ctx.runtimePaths?.copilotHome ?? join(homedir(), ".copilot"),
          packs: ctx.skillPacks?.activeRoots(undefined, { ignoreTags: true }) ?? [],
        };
        const extensions = (catalog?.current() ?? []).filter((skill) => skill.extends.includes(name)).map((skill) => skill.id);
        const [main, ...added] = await Promise.all([name, ...extensions].map((id) => readSkill(skillOptions, id)));
        if (!main) return toolFailure(`The playbook "${name}" could not be read.`);
        for (const id of [name, ...extensions]) ctx.skillUsageStore?.record(id, invocation.sessionId);
        const label = view?.label ?? playbook?.label ?? name;
        let steps = [
          `# Playbook: ${label}`,
          main.body,
          ...added.flatMap((skill) => skill ? [`# Added on this machine by ${skill.id}`, skill.body] : []),
        ].join("\n\n");
        if (steps.length > MAX_STEPS_CHARS) steps = `${steps.slice(0, MAX_STEPS_CHARS)}\n[truncated: load the rest with the skill tool]`;
        const required = playbook?.evidence ?? [];
        // The completion check is the last item on every playbook's todo list, so it is never left in a footnote.
        steps += delegated ? "\n\n# Final step for delegated work\nReturn your findings, evidence and limits to your parent agent instead of calling verify_complete." : `\n\n# Final step (required)\nBefore your final reply, call verify_complete with the evidence "Done means" describes${required.length > 0 ? ` (it must include ${required.join(", ")})` : ""}. Report results honestly: "pass" when a check supports the work you report (a reproduced bug is pass, and so is a premise you checked and found false), "fail" only when your own work failed a check, "not_run" for an in-scope check you could not run. List in-scope checks you skipped in unverified, and caveats outside what was asked in notes.`;
        return {
          success: true,
          playbook: name,
          label,
          requiredEvidence: required,
          ...(extensions.length > 0 ? { extensions } : {}),
          message: delegated ? `Use ${label} for your assignment. The parent chat is unchanged; return your evidence to the parent.` : `Recorded ${label}. Use the steps below for the remaining work; keep evidence that still applies, and mark a step you skip "skip: <reason>". When they are done, call verify_complete${required.length > 0 ? ` with evidence of kind ${required.join(", ")}` : ""}.${replacedUserChoice}`,
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
