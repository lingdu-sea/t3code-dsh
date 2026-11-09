import { describe, expect, it } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { NativeDshRuntime, type DshNativeOptions } from "./native.ts";
import { classifyDshTerminal } from "./nativeEvents.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-dsh-runtime.mjs", import.meta.url));
const options = (): DshNativeOptions => ({
  binaryPath: fixture,
  home: join(tmpdir(), "dsh-sdk-transport-" + randomUUID()),
  cwd: process.cwd(),
  provider: "offline-fixture-provider",
  model: "offline-fixture-model",
  // The fixture does not use an API, shell or secrets. Never copy credentials
  // from the developer's or CI's inherited process into this child.
  env: { PATH: process.env.PATH ?? "" },
});

describe("DSH native published SDK transport — offline subprocess", () => {
  it("initializes over JSON-RPC and receives an actual assistant event", async () => {
    const messages: string[] = [];
    const runtime = new NativeDshRuntime(options(), {
      onNotification: (notification) => {
        messages.push(notification.method);
      },
    });
    try {
      await runtime.start();
      const sessionId = runtime.createSessionId();
      const result = await runtime.run(sessionId, "hello");
      expect(result.sessionId).toBe(sessionId);
      expect(result.finalResponse).toBe("echo:hello");
      expect(result.finishReason).toBe("completed");
      expect(result.events.map((event) => event.type)).toContain("assistant/message");
      expect(messages).toContain("session.event");
      expect(runtime.isActive).toBe(false);
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("denies an unhandled SDK tool approval rather than auto-permitting", async () => {
    const runtime = new NativeDshRuntime(options());
    try {
      await runtime.start();
      const result = await runtime.run(runtime.createSessionId(), "approve");
      expect(result.finalResponse).toBe("permission-rejected");
      expect(result.events.map((event) => event.type)).toContain("tool/result");
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("passes an explicitly approved one-shot operation to SDK", async () => {
    const requests: string[] = [];
    const runtime = new NativeDshRuntime(options(), {
      onApproval: async (request) => {
        requests.push(request.toolName);
        return "allowed-once";
      },
    });
    try {
      await runtime.start();
      const result = await runtime.run(runtime.createSessionId(), "approve");
      expect(requests).toEqual(["fake-read-only"]);
      expect(result.finalResponse).toBe("permission-allowed-once");
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("forwards DSH structured questions to user callback and receives an answer", async () => {
    const runtime = new NativeDshRuntime(options(), {
      onQuestion: async (request) => {
        expect(request.questions[0]?.id).toBe("q1");
        return { answers: [{ id: "q1", selected: ["Yes"] }] };
      },
    });
    try {
      await runtime.start();
      const result = await runtime.run(runtime.createSessionId(), "question");
      expect(result.finalResponse).toBe("question-Yes");
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("cancels a structured question when no user callback exists", async () => {
    const runtime = new NativeDshRuntime(options());
    try {
      await runtime.start();
      const result = await runtime.run(runtime.createSessionId(), "question");
      expect(result.finalResponse).toBe("question-cancelled");
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("propagates resume errors and does not fabricate missing sessions", async () => {
    const runtime = new NativeDshRuntime(options());
    try {
      await runtime.start();
      await runtime.resumeSession("existing-fixture-session");
      await expect(runtime.resumeSession("missing")).rejects.toThrow();
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("rejects simultaneous turns on the same owned subprocess", async () => {
    const runtime = new NativeDshRuntime(options());
    try {
      await runtime.start();
      const sessionId = runtime.createSessionId();
      const first = runtime.run(sessionId, "slow");
      await expect(runtime.run(sessionId, "another turn")).rejects.toThrow(/active turn/);
      expect((await first).finalResponse).toBe("slow-finished");
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("preserves a non-success terminal reason despite assistant text", async () => {
    const runtime = new NativeDshRuntime(options());
    try {
      await runtime.start();
      const result = await runtime.run(runtime.createSessionId(), "non-success");
      expect(result.finalResponse).toBe("partial-output");
      expect(classifyDshTerminal(result.finishReason)).toBe("failed");
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("does not report success when an owned native subprocess dies", async () => {
    const runtime = new NativeDshRuntime(options());
    try {
      await runtime.start();
      await expect(runtime.run(runtime.createSessionId(), "crash")).rejects.toThrow();
      expect(runtime.isActive).toBe(false);
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it("will not restart an explicitly closed runtime", async () => {
    const runtime = new NativeDshRuntime(options());
    await runtime.start();
    await runtime.close();
    await runtime.close();
    expect(runtime.isClosed).toBe(true);
    await expect(runtime.start()).rejects.toThrow(/closed/);
    await expect(runtime.run("s", "hello")).rejects.toThrow(/closed/);
  }, 15_000);
});
