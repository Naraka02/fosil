import { createHash } from "node:crypto";
import {
  contextCompositionSchema, modelRequestContextSchema,
  type ContextComposition, type ContextContribution, type JsonValue, type ModelRequestContext,
  type PrunedToolResult
} from "@fosil/contracts";
import type { ExecutionState } from "@fosil/core";
import {
  localTokenEstimate, measureContext, serializedBytes, type ContextWindowPolicy
} from "./context-measurement.js";

export interface ToolResultPrunePolicy {
  thresholdChars: number;
  headChars: number;
  tailChars: number;
}

export const defaultToolResultPrunePolicy: Readonly<ToolResultPrunePolicy> = Object.freeze({
  thresholdChars: 8_192,
  headChars: 4_096,
  tailChars: 1_024
});

export interface RequestContextMetadata {
  readonly prunedToolResults: readonly PrunedToolResult[];
  readonly workspaceInstruction: {
    readonly status: "loaded" | "absent" | "rejected";
    readonly path: string;
    readonly sha256: string | null;
    readonly original_bytes: number | null;
    readonly retained_bytes: number | null;
    readonly truncated: boolean;
    readonly reason: string | null;
  } | null;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const points = (value: string) => Array.from(value);
const object = (value: unknown): Record<string, JsonValue> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, JsonValue> : null;

/** Bound settled tool result substance in the model projection without changing its canonical event. */
export function pruneRequestToolResults(request: ModelRequestContext,
  policy: ToolResultPrunePolicy = defaultToolResultPrunePolicy): { request: ModelRequestContext; pruned: PrunedToolResult[] } {
  const clone = structuredClone(request);
  const pruned: PrunedToolResult[] = [];
  clone.messages.forEach((message, messageIndex) => {
    if (message.role !== "tool" || !message.name || !message.tool_call_id) return;
    const content = object(message.content);
    if (!content || content.result === null || content.result === undefined) return;
    const serialized = JSON.stringify(content.result);
    const characters = points(serialized);
    if (characters.length <= policy.thresholdChars) return;
    const head = characters.slice(0, policy.headChars).join("");
    const tail = characters.slice(-policy.tailChars).join("");
    const preview = `${head}\n[... ${characters.length - policy.headChars - policy.tailChars} characters pruned from retained tool result ...]\n${tail}`;
    const replacement: JsonValue = {
      kind: "pruned_tool_result",
      preview,
      original_chars: characters.length,
      original_bytes: Buffer.byteLength(serialized, "utf8"),
      sha256: sha256(serialized)
    };
    message.content = { ...content, result: replacement };
    const retained = JSON.stringify(replacement);
    pruned.push({
      message_index: messageIndex,
      tool_name: message.name,
      tool_call_id: message.tool_call_id,
      original_chars: characters.length,
      retained_chars: points(retained).length,
      original_bytes: Buffer.byteLength(serialized, "utf8"),
      retained_bytes: Buffer.byteLength(retained, "utf8"),
      sha256: sha256(serialized)
    });
  });
  return { request: modelRequestContextSchema.parse(clone), pruned };
}

function contribution(kind: ContextContribution["kind"], label: string, value: unknown,
  itemCount: number, sourceIds: string[] = [], details: JsonValue | null = null,
  disposition: ContextContribution["disposition"] = "included"): ContextContribution {
  if (itemCount === 0) return {
    kind, label, disposition, estimated_tokens: 0, serialized_bytes: 0, item_count: 0, source_ids: sourceIds, details
  };
  return {
    kind, label, disposition, estimated_tokens: localTokenEstimate(value), serialized_bytes: serializedBytes(value),
    item_count: itemCount, source_ids: sourceIds, details
  };
}

function messageKind(content: JsonValue): string | null {
  const value = object(content);
  return typeof value?.kind === "string" ? value.kind : null;
}

/** Explain one exact admitted request; provider usage remains a separate terminal measurement. */
export function describeContextComposition(state: ExecutionState, request: ModelRequestContext,
  metadata: RequestContextMetadata, policy: ContextWindowPolicy | null): ContextComposition {
  const workspace = request.messages.filter((message) => messageKind(message.content) === "workspace_instructions");
  const checkpoints = request.messages.filter((message) => messageKind(message.content) === "context_checkpoint");
  const history = request.messages.filter((message) => !workspace.includes(message) && !checkpoints.includes(message));
  const checkpointIds = checkpoints.flatMap((message) => {
    const content = object(message.content);
    const source = content && object(content.source);
    return typeof source?.sha256 === "string" ? [source.sha256] : [];
  });
  const workspaceIds = workspace.flatMap((message) => {
    const content = object(message.content);
    const source = content && object(content.source);
    return typeof source?.sha256 === "string" ? [source.sha256] : [];
  });
  const contributions = [
    contribution("system_instructions", "System instructions", request.system_instructions,
      request.system_instructions.length),
    contribution("workspace_instructions", "Workspace instructions", workspace, workspace.length,
      workspaceIds, metadata.workspaceInstruction as unknown as JsonValue,
      metadata.workspaceInstruction?.status === "loaded" ? "included" : "omitted"),
    contribution("checkpoint", "Context checkpoint", checkpoints, checkpoints.length, checkpointIds),
    contribution("recent_history", "Recent conversation history", history, history.length),
    contribution("tool_schemas", "Tool schemas", request.tools, request.tools.length),
    ...(metadata.prunedToolResults.length ? [contribution(
      "tool_result_pruning", "Pruned tool results", metadata.prunedToolResults,
      metadata.prunedToolResults.length, metadata.prunedToolResults.map((item) => item.sha256),
      metadata.prunedToolResults as unknown as JsonValue, "transformed"
    )] : [])
  ];
  return contextCompositionSchema.parse({
    measurement: policy ? measureContext(state, request, policy) : null,
    contributions,
    pruned_tool_results: metadata.prunedToolResults
  });
}
