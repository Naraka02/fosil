import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { modelRequestContextSchema, type JsonValue, type ModelRequestContext } from "@fosil/contracts";

const sourceLimitBytes = 1024 * 1024;
const retainedLimitBytes = 64 * 1024;
const truncationMarker = "\n[WORKSPACE INSTRUCTIONS TRUNCATED]";

export interface WorkspaceInstructionObservation {
  readonly status: "loaded" | "absent" | "rejected";
  readonly path: string;
  readonly sha256: string | null;
  readonly original_bytes: number | null;
  readonly retained_bytes: number | null;
  readonly truncated: boolean;
  readonly reason: string | null;
}

export interface WorkspaceInstructionResult {
  readonly request: ModelRequestContext;
  readonly observation: WorkspaceInstructionObservation;
}

const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function retainedPrefix(value: Buffer): string {
  if (value.byteLength <= retainedLimitBytes) return new TextDecoder("utf-8", { fatal: true }).decode(value);
  const markerBytes = Buffer.byteLength(truncationMarker, "utf8");
  let end = retainedLimitBytes - markerBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try { return `${decoder.decode(value.subarray(0, end))}${truncationMarker}`; }
    catch { end--; }
  }
  return truncationMarker;
}

/** Load the pinned workspace root instruction file without following links or blocking request admission on absence. */
export async function applyWorkspaceInstructions(request: ModelRequestContext, workspaceRoot: string): Promise<WorkspaceInstructionResult> {
  const relativePath = "AGENTS.md";
  const target = join(workspaceRoot, relativePath);
  let handle;
  try {
    if (await realpath(workspaceRoot) !== workspaceRoot) throw new Error("workspace_changed");
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error("unsupported_file");
    if (before.size > BigInt(sourceLimitBytes)) throw new Error("file_too_large");
    const content = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < content.byteLength) {
      const part = await handle.read(content, offset, content.byteLength - offset, offset);
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== content.byteLength || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("file_changed");
    }
    const instructions = retainedPrefix(content);
    if (instructions.includes("\0")) throw new Error("unsupported_text");
    const source = {
      path: relativePath,
      sha256: digest(content),
      original_bytes: content.byteLength,
      retained_bytes: Buffer.byteLength(instructions, "utf8"),
      truncated: content.byteLength > retainedLimitBytes
    };
    const message = {
      role: "user" as const,
      content: {
        kind: "workspace_instructions",
        authority: "workspace_guidance",
        scope: workspaceRoot,
        source,
        instruction: "Apply these repository instructions when relevant. More specific direct user and system instructions take precedence.",
        instructions
      } satisfies JsonValue
    };
    return {
      request: modelRequestContextSchema.parse({ ...request, messages: [message, ...request.messages] }),
      observation: { status: "loaded", ...source, reason: null }
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const absent = code === "ENOENT";
    return {
      request,
      observation: {
        status: absent ? "absent" : "rejected", path: relativePath, sha256: null,
        original_bytes: null, retained_bytes: null, truncated: false,
        reason: absent ? "not_found" : error instanceof Error ? error.message : "read_failed"
      }
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}
