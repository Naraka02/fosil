import { useEffect, useRef, useState } from "react";
import type { Event } from "@fosil/contracts";
import { loadHistory, parseStreamEvent } from "../../api.js";
import { appendCanonicalEvent, EventSequenceError } from "../chat/chat-model.js";

export type Connection = "loading" | "live" | "reconnecting" | "offline";

export function useSessionStream(sessionId: string | null) {
  const [events, setEvents] = useState<Event[]>([]);
  const [connection, setConnection] = useState<Connection>("loading");
  const [streamError, setStreamError] = useState<string | null>(null);
  const eventsRef = useRef<Event[]>([]);

  useEffect(() => {
    if (!sessionId) { eventsRef.current = []; setEvents([]); setConnection("offline"); return; }
    let disposed = false;
    let source: EventSource | undefined;
    let retry: number | undefined;
    const control = new AbortController();
    const reconnect = () => {
      source?.close();
      if (disposed) return;
      setConnection("reconnecting");
      if (retry !== undefined) window.clearTimeout(retry);
      retry = window.setTimeout(() => { retry = undefined; void connect(); }, 400);
    };
    const connect = async () => {
      try {
        setConnection("loading");
        const history = await loadHistory(sessionId, control.signal);
        if (disposed) return;
        eventsRef.current = history;
        setEvents(history);
        source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events?after=${history.at(-1)?.seq ?? 0}`);
        source.onopen = () => { if (!disposed) { setConnection("live"); setStreamError(null); } };
        source.addEventListener("execution", (incoming) => {
          try {
            const next = appendCanonicalEvent(eventsRef.current, parseStreamEvent((incoming as MessageEvent<string>).data));
            eventsRef.current = next;
            setEvents(next);
          } catch (failure) {
            setStreamError(failure instanceof EventSequenceError
              ? "流式读取时历史已变化，正在重建视图。"
              : "事件流包含无效数据。");
            reconnect();
          }
        });
        source.onerror = reconnect;
      } catch (failure) {
        if (disposed || control.signal.aborted) return;
        setConnection("offline");
        setStreamError(failure instanceof Error ? failure.message : "无法读取会话历史");
        if (retry !== undefined) window.clearTimeout(retry);
        retry = window.setTimeout(() => { retry = undefined; void connect(); }, 1000);
      }
    };
    void connect();
    return () => {
      disposed = true;
      control.abort();
      source?.close();
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [sessionId]);

  return { events, connection, streamError, clearStreamError: () => setStreamError(null) };
}
