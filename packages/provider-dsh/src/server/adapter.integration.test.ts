// This tests the actual T3 ProviderAdapterV2 event stream over a published DSH
// SDK subprocess protocol. It does not perform a real model inference.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Local offline fixture URL.
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId, NodeId, ProjectId, ProviderInstanceId, ProviderSessionId,
  RunAttemptId, RunId, ThreadId, type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DshSettings } from "../settings.ts";
import { makeDshAdapterV2 } from "./adapter.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-dsh-runtime.mjs", import.meta.url));
const TEST_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const settings = Schema.decodeSync(DshSettings)({
  enabled: true,
  binaryPath: fixture,
  provider: "offline-fixture-provider",
  model: "offline-fixture-model",
});
const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "approval-required", interactionMode: "default", cwd: null,
});

const makeHarness = Effect.fnUntraced(function* (identity: string) {
  const instanceId = ProviderInstanceId.make("dsh-instance-" + identity);
  const threadId = ThreadId.make("dsh-thread-" + identity);
  const modelSelection = {
    instanceId, model: "offline-fixture-model", options: [],
  };
  const adapter = yield* makeDshAdapterV2({
    instanceId,
    settings,
    environment: TEST_ENV,
  });
  const runtime = yield* adapter.openSession({
    threadId, providerSessionId: ProviderSessionId.make("dsh-session-" + identity),
    modelSelection, runtimePolicy: policy,
  });
  const collected: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => {
      collected.push(event);
      Queue.offerUnsafe(queue, event);
    })),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId, modelSelection, runtimePolicy: policy,
  });
  const appThread: OrchestrationV2AppThread = {
    id: threadId, projectId: ProjectId.make("dsh-project-" + identity),
    title: "DSH offline E2E", createdBy: "user", creationSource: "web",
    providerInstanceId: instanceId, modelSelection,
    runtimeMode: policy.runtimeMode, interactionMode: policy.interactionMode,
    branch: null, worktreePath: null, activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null, createdAt: yield* Effect.sync(() => providerThread.createdAt),
    updatedAt: providerThread.updatedAt, archivedAt: null, settledOverride: null,
    settledAt: null, lastVisitedAt: null, deletedAt: null,
  };
  const nextEvent = Effect.fnUntraced(function* (
    predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
  ) {
    while (true) {
      const candidate = yield* Queue.take(queue).pipe(Effect.timeout(12_000));
      if (predicate(candidate)) return candidate;
    }
  });
  const startTurn = Effect.fnUntraced(function* (prompt: string, ordinal = 1) {
    yield* runtime.startTurn({
      appThread, threadId,
      runId: RunId.make(identity + "-run-" + ordinal),
      runOrdinal: ordinal, providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(identity + "-attempt-" + ordinal),
      rootNodeId: NodeId.make(identity + "-root-" + ordinal),
      providerThread,
      message: {
        messageId: MessageId.make(identity + "-message-" + ordinal),
        text: prompt, attachments: [], createdBy: "user", creationSource: "web",
      },
      modelSelection, runtimePolicy: policy,
    });
  });
  const terminal = nextEvent((e) => e.type === "turn.terminal");
  return { runtime, threadId, instanceId, providerThread, collected, nextEvent, startTurn, terminal };
});

describe("DSH ProviderAdapterV2 -> native SDK offline integration", () => {
  it.effect("maps native assistant events and a terminal into the T3 queue in order", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("hello");
      yield* h.startTurn("hello");
      const terminal = yield* h.terminal;
      assert.equal(terminal.type, "turn.terminal");
      if (terminal.type !== "turn.terminal") return;
      assert.equal(terminal.status, "completed");
      const message = h.collected.find((x) => x.type === "message.updated");
      assert.equal(message?.type, "message.updated");
      if (message?.type !== "message.updated") return;
      assert.equal(message.message.text, "echo:hello");
      assert.isTrue(h.collected.indexOf(message) < h.collected.indexOf(terminal));
      assert.equal(h.runtime.providerSession.status, "ready");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("bridges T3 one-shot approval to native JSON-RPC permission outcome", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("approval");
      yield* h.startTurn("approve");
      const request = yield* h.nextEvent((x) =>
        x.type === "runtime_request.updated" && x.runtimeRequest.status === "pending",
      );
      assert.equal(request.type, "runtime_request.updated");
      if (request.type !== "runtime_request.updated") return;
      assert.equal(request.runtimeRequest.kind, "permission");
      yield* h.runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id, decision: "accept",
      });
      const terminal = yield* h.terminal;
      assert.equal(terminal.type, "turn.terminal");
      const result = h.collected.find((x) =>
        x.type === "message.updated" && x.message.text === "permission-allowed-once",
      );
      assert.isDefined(result);
      const tool = h.collected.find((x) =>
        x.type === "turn_item.updated" && x.turnItem.type === "dynamic_tool" && x.turnItem.status === "completed",
      );
      assert.isDefined(tool);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("maps native structured questions into T3 user-input and back", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("question");
      yield* h.startTurn("question");
      const request = yield* h.nextEvent((x) =>
        x.type === "runtime_request.updated" && x.runtimeRequest.kind === "user_input" &&
        x.runtimeRequest.status === "pending",
      );
      assert.equal(request.type, "runtime_request.updated");
      if (request.type !== "runtime_request.updated") return;
      const item = h.collected.find((x) =>
        x.type === "turn_item.updated" && x.turnItem.type === "user_input_request",
      );
      assert.isDefined(item);
      yield* h.runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id, answers: { q1: "Yes" },
      });
      const terminal = yield* h.terminal;
      assert.equal(terminal.type, "turn.terminal");
      assert.isTrue(h.collected.some((x) =>
        x.type === "message.updated" && x.message.text === "question-Yes",
      ));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps separate provider instances' messages and session identities distinct", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness("instance-A");
      const second = yield* makeHarness("instance-B");
      assert.notEqual(first.providerThread.nativeThreadRef?.nativeId,
        second.providerThread.nativeThreadRef?.nativeId);
      yield* first.startTurn("alpha");
      yield* second.startTurn("beta");
      yield* first.terminal;
      yield* second.terminal;
      const texts = (events: typeof first.collected) =>
        events.filter((x) => x.type === "message.updated").map((x) => x.message.text);
      assert.deepEqual(texts(first.collected), ["echo:alpha"]);
      assert.deepEqual(texts(second.collected), ["echo:beta"]);
      assert.isTrue(first.collected.every((x) => x.driver === "dsh"));
      assert.isTrue(second.collected.every((x) => x.driver === "dsh"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails a T3 run when the DSH subprocess dies", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("crash");
      yield* h.startTurn("crash");
      const terminal = yield* h.terminal;
      assert.equal(terminal.type, "turn.terminal");
      if (terminal.type !== "turn.terminal") return;
      assert.equal(terminal.status, "failed");
      assert.equal(h.runtime.providerSession.status, "error");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("never advertises unsafe Stop, rollback or unrestricted mode", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness("capabilities");
      const capabilities = yield* (yield* makeDshAdapterV2({
        instanceId: h.instanceId, settings, environment: TEST_ENV,
      })).getCapabilities();
      assert.isFalse(capabilities.turns.supportsInterrupt);
      assert.isFalse(capabilities.threads.canRollbackThread);
      assert.isFalse(capabilities.subagents.supportsSubagents);
      const stopped = yield* h.runtime.interruptTurn({
        providerThread: h.providerThread,
        providerTurnId: h.providerThread.id as never,
      }).pipe(Effect.result);
      assert.equal(stopped._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
