import { z } from "zod";

const relativeFile = z.string().min(1).max(4096).refine((path) =>
  !path.includes("\\") && !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(path) && !/^[a-z]:/i.test(path)
  && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"expected a relative file path without traversal").describe(
  "Workspace-relative path (for example docs/development.md); never absolute; excludes .git, .agents, and .codex."
);
const readArguments = z.object({
  path: relativeFile,
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(2000).optional()
}).strict();
const searchArguments = z.object({
  path: relativeFile, query: z.string().min(1).max(256).refine((query) => !/[\r\n\0]/.test(query), "expected a single-line literal query"),
  max_matches: z.number().int().min(1).max(100).optional()
}).strict();
const expectedDigest = z.string().regex(/^[a-f0-9]{64}$/);
const replacementText = z.string().max(1024 * 1024);
const oldText = z.string().min(1).max(1024 * 1024);
const replaceArguments = z.object({
  path: relativeFile, expected_sha256: expectedDigest, replacement: replacementText
}).strict();
const literalEditArguments = z.object({
  path: relativeFile, expected_sha256: expectedDigest,
  old_text: oldText, new_text: replacementText,
  replace_all: z.boolean().optional()
}).strict();
const editArguments = z.union([replaceArguments, literalEditArguments]);
// Function providers require a root object schema. Runtime parsing above keeps
// the two edit forms mutually exclusive and rejects incomplete combinations.
const editWireArguments = z.object({
  path: relativeFile,
  expected_sha256: expectedDigest,
  replacement: replacementText.optional().describe("Complete replacement form; omit old_text, new_text, and replace_all."),
  old_text: oldText.optional().describe("Focused edit form; provide together with new_text and omit replacement."),
  new_text: replacementText.optional().describe("Focused edit form; provide together with old_text."),
  replace_all: z.boolean().optional().describe("Focused edit only; replace every exact old_text match when true.")
}).strict().describe("Provide either replacement, or both old_text and new_text. Runtime validation rejects mixed or incomplete forms.");
const directory = relativeFile.optional();
const globPattern = z.string().min(1).max(512).refine((value) =>
  !value.includes("\\") && !/^[a-z]:/i.test(value) && !value.startsWith("/")
  && !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value)
  && value.split("/").every((part) => part !== ".."), "expected a workspace-relative glob without traversal").describe(
  "Workspace-relative glob (for example src/**/*.ts); never absolute or parent-traversing."
);
const globArguments = z.object({ pattern: globPattern, path: directory, max_results: z.number().int().min(1).max(500).optional() }).strict();
const grepArguments = z.object({
  query: z.string().min(1).max(256).refine((query) => !/[\r\n\0]/.test(query), "expected a single-line literal query"),
  path: directory, include: globPattern.optional(), max_matches: z.number().int().min(1).max(200).optional()
}).strict();
const writeArguments = z.object({
  path: relativeFile, expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), content: z.string().max(1024 * 1024)
}).strict();

export const fileToolInvocationSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("read_file"), arguments: readArguments }).strict(),
  z.object({ name: z.literal("search_text"), arguments: searchArguments }).strict(),
  z.object({ name: z.literal("glob"), arguments: globArguments }).strict(),
  z.object({ name: z.literal("grep"), arguments: grepArguments }).strict(),
  z.object({ name: z.literal("write_file"), arguments: writeArguments }).strict(),
  z.object({ name: z.literal("edit_file"), arguments: editArguments }).strict()
]);
export type FileToolInvocation = z.infer<typeof fileToolInvocationSchema>;

export function parseFileToolInvocation(value: unknown): FileToolInvocation { return fileToolInvocationSchema.parse(value); }
export function fileToolRequiresApproval(name: string): boolean { return name === "edit_file" || name === "write_file"; }

/** Fresh JSON schemas for context assembly; the runtime parser also enforces refinements. */
export function fileToolDefinitions() {
  return [
    { name: "read_file", description: "Read one bounded UTF-8 file and its SHA-256 digest.", parameters: z.toJSONSchema(readArguments) },
    { name: "search_text", description: "Find literal text within one UTF-8 file, with line numbers and bounded previews.", parameters: z.toJSONSchema(searchArguments) },
    { name: "glob", description: "Discover bounded workspace-relative file paths matching one glob pattern.", parameters: z.toJSONSchema(globArguments) },
    { name: "grep", description: "Search bounded workspace files for one case-sensitive literal query.", parameters: z.toJSONSchema(grepArguments) },
    { name: "write_file", description: "Create a UTF-8 file when expected_sha256 is null, or replace an existing file when its digest matches. Read Only requires approval.", parameters: z.toJSONSchema(writeArguments) },
    { name: "edit_file", description: "Change an existing UTF-8 file when its SHA-256 digest matches, using either a complete replacement or an exact literal edit. Read Only requires approval.", parameters: z.toJSONSchema(editWireArguments) }
  ];
}
