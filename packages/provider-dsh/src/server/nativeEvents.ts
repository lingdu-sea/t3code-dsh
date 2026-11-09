import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";

export type NativeDshEvent =
  | { readonly kind: "assistant"; readonly key: string; readonly text: string; readonly reasoning: string }
  | { readonly kind: "tool-start"; readonly callId: string; readonly name: string; readonly arguments: string }
  | { readonly kind: "tool-end"; readonly callId: string; readonly text: string; readonly isError: boolean }
  | { readonly kind: "turn-end"; readonly reason: string };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>) : null;

function textBlocks(content: unknown, kind: "text" | "reasoning"): string {
  return Array.isArray(content)
    ? content.flatMap((block) => {
        const value = record(block);
        return value?.type === kind && typeof value.text === "string"
          ? [value.text] : [];
      }).join("")
    : "";
}

/**
 * SDK notifications contain a SessionEvent envelope; do not infer tool
 * execution from arbitrary stderr or ACP notifications.
 */
export function readNativeDshEvent(notification: HarnessNotification, sessionId: string): NativeDshEvent | null {
  if (notification.method !== "session.event") return null;
  if (notification.params.sessionId !== sessionId) return null;
  const event = record(notification.params.event);
  if (!event) return null;
  const data = record(event.data);
  if (!data) return null;
  if (event.type === "assistant/message") {
    const message = record(data.message);
    const key = typeof event.seq === "number" || typeof event.seq === "string"
      ? String(event.seq) : null;
    if (!message || !key) return null;
    return {
      kind: "assistant", key,
      text: textBlocks(message.content, "text"),
      reasoning: textBlocks(message.content, "reasoning"),
    };
  }
  if (event.type === "tool/call" &&
      typeof data.callId === "string" && data.callId &&
      typeof data.name === "string" && data.name &&
      typeof data.arguments === "string") {
    return { kind: "tool-start", callId: data.callId, name: data.name, arguments: data.arguments };
  }
  if (event.type === "tool/result") {
    const message = record(data.message);
    if (!message || typeof message.toolCallId !== "string" || !message.toolCallId) return null;
    return {
      kind: "tool-end",
      callId: message.toolCallId,
      text: textBlocks(message.content, "text").slice(0, 16_384),
      isError: message.isError === true,
    };
  }
  if (event.type === "turn/end") {
    const reason = record(data.reason);
    return typeof reason?.kind === "string" ? { kind: "turn-end", reason: reason.kind } : null;
  }
  return null;
}

export type NativeDshTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";

/** Only the explicit completed reason is a successful turn. */
export function classifyDshTerminal(reason: string | null): NativeDshTerminalStatus {
  switch (reason) {
    case "completed": return "completed";
    case "aborted": return "cancelled";
    case "interrupted": return "interrupted";
    default: return "failed";
  }
}
