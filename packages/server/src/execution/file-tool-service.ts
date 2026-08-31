import { parseFileToolInvocation } from "@fosil/contracts";
import { ToolService } from "./tool-service.js";

/** Retains the original file-only entry point; shell calls require ToolService. */
export class FileToolService extends ToolService {
  protected override parseInvocation(value: unknown) { return parseFileToolInvocation(value); }
}
export type { ToolServiceOptions as FileToolServiceOptions, ToolAdvance } from "./tool-service.js";
