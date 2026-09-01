import type { ContextMeasurement, ModelRequestContext } from "@fosil/contracts";
import type { ExecutionState } from "@fosil/core";

export interface ContextWindowPolicy {
  contextTokens: number;
  executionOutputTokens: number;
  safetyTokens: number;
  proactiveRatio: number;
  targetRatio: number;
  retainRawTokens: number;
  requestByteTrigger: number;
  compactionOutputTokens: number;
}

export const deepSeekContextPolicy: Readonly<ContextWindowPolicy> = Object.freeze({
  contextTokens: 1_000_000,
  executionOutputTokens: 64_000,
  safetyTokens: 32_000,
  proactiveRatio: 0.7,
  targetRatio: 0.35,
  retainRawTokens: 160_000,
  requestByteTrigger: 6 * 1024 * 1024,
  compactionOutputTokens: 16_000
});

export const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Conservative provider-neutral estimate, calibrated upward at the complete-request boundary. */
export function localTokenEstimate(value: unknown): number {
  const serialized = JSON.stringify(value);
  let ascii = 0;
  let nonAscii = 0;
  for (const point of serialized) point.codePointAt(0)! <= 0x7f ? ascii++ : nonAscii++;
  return Math.max(1, Math.ceil(ascii / 2 + nonAscii));
}

function calibration(state: ExecutionState): number {
  let factor = 1;
  for (const run of state.runs.values()) {
    for (const request of run.requests.values()) {
      if (request.usage?.input_tokens == null) continue;
      factor = Math.max(factor, request.usage.input_tokens / localTokenEstimate(request.context) * 1.1);
    }
  }
  return factor;
}

export function measureContext(state: ExecutionState, request: ModelRequestContext,
  policy: ContextWindowPolicy = deepSeekContextPolicy): ContextMeasurement {
  return {
    estimated_input_tokens: Math.ceil(localTokenEstimate(request) * calibration(state)),
    serialized_bytes: serializedBytes(request),
    hard_input_tokens: policy.contextTokens - policy.executionOutputTokens - policy.safetyTokens
  };
}

export function compactionTrigger(measurement: ContextMeasurement,
  policy: ContextWindowPolicy = deepSeekContextPolicy): "token_pressure" | "request_bytes" | null {
  if (measurement.estimated_input_tokens >= Math.floor(measurement.hard_input_tokens * policy.proactiveRatio)) return "token_pressure";
  if (measurement.serialized_bytes >= policy.requestByteTrigger) return "request_bytes";
  return null;
}
