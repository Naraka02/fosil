import {
  parseEvent,
  sessionCreatedEventInputSchema,
  type Event,
  type SessionCreatedEventInput
} from "@fosil/contracts";

export { parseEvent, sessionCreatedEventInputSchema };
export type { Event, SessionCreatedEventInput };

export function validateEvent(value: unknown): Event {
  return parseEvent(value);
}
