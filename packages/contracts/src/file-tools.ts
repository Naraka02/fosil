import { z } from "zod";

const relativeFile = z.string().min(1).max(4096).refine((path) =>
  !path.includes("\\") && !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(path) && !/^[a-z]:/i.test(path)
  && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"expected a relative file path without traversal");
const readArguments = z.object({ path: relativeFile }).strict();
const searchArguments = z.object({
  path: relativeFile, query: z.string().min(1).max(256).refine((query) => !/[\r\n\0]/.test(query), "expected a single-line literal query"),
  max_matches: z.number().int().min(1).max(100).optional()
}).strict();
const editArguments = z.object({
  path: relativeFile, expected_sha256: z.string().regex(/^[a-f0-9]{64}$/), replacement: z.string().max(1024 * 1024)
}).strict();

export const fileToolInvocationSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("read_file"), arguments: readArguments }).strict(),
  z.object({ name: z.literal("search_text"), arguments: searchArguments }).strict(),
  z.object({ name: z.literal("edit_file"), arguments: editArguments }).strict()
]);
export type FileToolInvocation = z.infer<typeof fileToolInvocationSchema>;

export function parseFileToolInvocation(value: unknown): FileToolInvocation { return fileToolInvocationSchema.parse(value); }
export function fileToolRequiresApproval(name: string): boolean { return name === "edit_file"; }

/** Fresh JSON schemas for future context assembly; the runtime parser also enforces refinements. */
export function fileToolDefinitions() {
  return [
    { name: "read_file", description: "Read one bounded UTF-8 file and its SHA-256 digest.", parameters: z.toJSONSchema(readArguments) },
    { name: "search_text", description: "Find literal text within one UTF-8 file, with line numbers and bounded previews.", parameters: z.toJSONSchema(searchArguments) },
    { name: "edit_file", description: "Replace an existing UTF-8 file only when its SHA-256 digest still matches; requires approval.", parameters: z.toJSONSchema(editArguments) }
  ];
}
