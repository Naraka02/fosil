import { modelRequestContextSchema, toolDefinitions, type ModelRequestContext } from "@fosil/contracts";
import { buildModelHistory } from "./history.js";
import type { ExecutionState } from "./index.js";

export interface ModelRequestOptions {
  provider: string;
  model: string;
  system_instructions: readonly string[];
  settings: ModelRequestContext["settings"];
}

/** Assemble the provider-neutral request from authoritative, settled history. */
export function buildModelRequest(state: ExecutionState, options: ModelRequestOptions): ModelRequestContext {
  const messages: ModelRequestContext["messages"] = buildModelHistory(state).map((message) => {
    if (message.role === "user") return { role: "user", content: message.content };
    if (message.role === "assistant") {
      const { role, ...content } = message;
      return { role, content };
    }
    return {
      role: "tool", name: message.name, tool_call_id: message.provider_call_id,
      content: { ...message.content, run_id: message.run_id, request_id: message.request_id }
    };
  });
  // Parsing validates the assembled boundary; cloning also detaches JSON subtrees
  // retained by the shared JSON schema, options, and tool definitions.
  return structuredClone(modelRequestContextSchema.parse({
    ...options, system_instructions: [...options.system_instructions], messages, tools: toolDefinitions()
  }));
}
