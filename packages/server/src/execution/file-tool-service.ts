import { ToolService } from "./tool-service.js";
import { createFileToolRegistry } from "./tool-registry.js";
import type { SqliteWorkerStore } from "../storage/store.js";
import type { ToolServiceOptions } from "./tool-service.js";

/** Retains the original file-only entry point; shell calls require ToolService. */
export class FileToolService extends ToolService {
  constructor(store: SqliteWorkerStore, options: ToolServiceOptions = {}) {
    super(store, { ...options, registry: createFileToolRegistry() });
  }
}
export type { ToolServiceOptions as FileToolServiceOptions, ToolAdvance } from "./tool-service.js";
