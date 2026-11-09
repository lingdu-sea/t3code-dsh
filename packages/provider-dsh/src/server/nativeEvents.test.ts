import { describe, expect, it } from "vite-plus/test";
import { classifyDshTerminal, readNativeDshEvent } from "./nativeEvents.ts";

const notification = (sessionId: string, event: unknown) => ({
  method: "session.event", params: { sessionId, event },
});

describe("DSH native event translation", () => {
  it("extracts assistant text and reasoning from one recorded step", () => {
    expect(readNativeDshEvent(notification("s1", {
      seq: 3, type: "assistant/message",
      data: { message: { content: [
        { type: "reasoning", text: "Plan" }, { type: "text", text: "Answer" },
      ] } },
    }), "s1")).toEqual({ kind: "assistant", key: "3", text: "Answer", reasoning: "Plan" });
  });
  it("pairs tool calls and outcomes using native call ids", () => {
    expect(readNativeDshEvent(notification("s1", {
      type: "tool/call", data: { callId: "t1", name: "read_file", arguments: "{\\\"path\\\":\\\"a\\\"}" },
    }), "s1")).toMatchObject({ kind: "tool-start", callId: "t1" });
    expect(readNativeDshEvent(notification("s1", {
      type: "tool/result", data: { message: { toolCallId: "t1",
        content: [{ type: "text", text: "file" }], isError: false } },
    }), "s1")).toEqual({ kind: "tool-end", callId: "t1", text: "file", isError: false });
  });
  it("does not display another SDK session's events", () => {
    expect(readNativeDshEvent(notification("foreign", { type: "turn/end", data: { reason: { kind: "completed" } } }), "s1")).toBeNull();
  });
  it("fails closed for every non-completed terminal", () => {
    expect(classifyDshTerminal("completed")).toBe("completed");
    expect(classifyDshTerminal("aborted")).toBe("cancelled");
    expect(classifyDshTerminal("interrupted")).toBe("interrupted");
    expect(classifyDshTerminal("max-tokens")).toBe("failed");
    expect(classifyDshTerminal(null)).toBe("failed");
  });
});
