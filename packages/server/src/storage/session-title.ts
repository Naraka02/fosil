import type { Event } from "@fosil/contracts";

const fallbackTitle = "新会话";
const maximumTitleCodePoints = 32;

export function deriveSessionTitle(events: readonly Event[]): string {
  const firstMessage = events.find((event) => event.type === "user.message");
  if (!firstMessage) return fallbackTitle;

  const normalized = firstMessage.data.content.replace(/\s+/gu, " ").trim();
  if (!normalized) return fallbackTitle;

  const codePoints = [...normalized];
  return codePoints.length > maximumTitleCodePoints
    ? `${codePoints.slice(0, maximumTitleCodePoints).join("")}…`
    : normalized;
}
