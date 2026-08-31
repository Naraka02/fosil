import type { Event } from "@fosil/contracts";

export const releaseTestCommand = "node --test sum.test.cjs";
export const releaseFailingSource = "module.exports = (a, b) => a - b;\n";
export const releaseRepairedSource = "module.exports = (a, b) => a + b;\n";

const objectValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateReleaseApproval(
  event: Extract<Event, { type: "approval.requested" }>,
  workspace: string,
  sourceDigest: string
): void {
  if (event.data.cwd !== workspace) throw new Error("The model requested approval outside the isolated fixture workspace");
  const argumentsValue = event.data.arguments;
  if (!objectValue(argumentsValue)) throw new Error("The model requested approval with non-object arguments");
  const keys = Object.keys(argumentsValue).sort().join(",");
  if (event.data.tool_name === "shell") {
    if (keys !== "command" || argumentsValue.command !== releaseTestCommand) {
      throw new Error("The model requested an unapproved shell command");
    }
    return;
  }
  if (event.data.tool_name === "edit_file") {
    if (keys !== "expected_sha256,path,replacement" || argumentsValue.path !== "sum.cjs"
      || argumentsValue.expected_sha256 !== sourceDigest || argumentsValue.replacement !== releaseRepairedSource) {
      throw new Error("The model requested an edit outside the exact fixture repair");
    }
    return;
  }
  throw new Error(`The model requested an unexpected gated tool: ${event.data.tool_name}`);
}
