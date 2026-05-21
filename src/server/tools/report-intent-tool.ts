import { defineTool } from "@github/copilot-sdk";
import type { ToolResultObject } from "@github/copilot-sdk";

export function createReportIntentTools() {
  return [
    defineTool("report_intent", {
      overridesBuiltInTool: true,
      skipPermission: true,
      description: [
        "Update the visible session intent.",
        "Use only with real tool work; omit if it would be alone.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", description: "Concise current phase." },
        },
        required: ["intent"],
        additionalProperties: false,
      },
      handler: async (args: any): Promise<ToolResultObject> => {
        const intent = typeof args.intent === "string" ? args.intent.trim() : "";
        if (!intent) {
          return {
            textResultForLlm: "Intent must not be blank",
            resultType: "failure",
            error: "blank intent",
            toolTelemetry: {},
          };
        }

        return {
          textResultForLlm: "Intent logged",
          resultType: "success",
          sessionLog: intent,
          toolTelemetry: {},
        };
      },
    }),
  ];
}
