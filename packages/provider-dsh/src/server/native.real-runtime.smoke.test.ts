import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- SDK smoke test creates an OS temp directory.
import { join } from "node:path";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Unique offline SDK test directory.
import { randomUUID } from "node:crypto";
import { NativeDshRuntime } from "./native.ts";

const runReal = process.env.T3_DSH_REAL_SMOKE === "1";

describe("DSH native runtime SDK profile — credential-free smoke", () => {
  it.skipIf(!runReal)("performs the actual DSH profile initialization and reaps its subprocess", async () => {
    // Does not make a model request. Isolated DSH_HOME and an explicit
    // minimal environment prevent inheriting unrelated CI/T3 provider secrets.
    const runtime = new NativeDshRuntime({
      home: join(tmpdir(), "dsh-profile-sdk-smoke-" + randomUUID()),
      cwd: process.cwd(),
      provider: "offline-handshake-provider",
      model: "offline-handshake-model",
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        LANG: "C.UTF-8",
      },
    });
    try {
      await runtime.start();
      expect(runtime.isClosed).toBe(false);
      expect(runtime.createSessionId().length).toBeGreaterThan(5);
    } finally {
      await runtime.close();
    }
    expect(runtime.isClosed).toBe(true);
  }, 30_000);
});
