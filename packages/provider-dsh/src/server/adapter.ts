import {
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ConversationMessage,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createHash } from "node:crypto";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { DshSettings } from "../settings.ts";
import { NativeDshRuntime } from "./native.ts";

export const DSH_PROVIDER = ProviderDriverKind.make("dsh");

// Conservative feature declarations: these only describe the functions
// implemented in THIS adapter, not every feature supported in DSH itself.
export const DSH_CAPABILITIES = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: false,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface DshAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: DshSettings;
  readonly environment: NodeJS.ProcessEnv;
}

export const makeDshAdapterV2 = Effect.fn("makeDshAdapterV2")(function* (
  options: DshAdapterOptions,
) {
  const host = yield* ProviderHost.ProviderHost;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const unsupported = (detail: string) => new ProviderAdapter.ProviderAdapterProtocolError({
    driver: DSH_PROVIDER, detail,
  });
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: DSH_PROVIDER,
    getCapabilities: () => Effect.succeed(DSH_CAPABILITIES),
    planSelectionTransition: (input) => Effect.succeed(
      input.current.model === input.target.model
        ? { type: "apply_on_next_turn" as const }
        : { type: "restart_session" as const },
    ),
    openSession: Effect.fn("DshAdapter.openSession")(function* (input) {
      if (!options.settings.enabled) return yield* unsupported("DSH is disabled");
      if (input.runtimePolicy.runtimeMode !== "approval-required")
        return yield* unsupported("This preview supports Supervised mode only");
      if (input.runtimePolicy.interactionMode === "plan")
        return yield* unsupported("Plan-mode projection is not implemented");
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId, driver: DSH_PROVIDER,
        providerInstanceId: options.instanceId, status: "ready",
        cwd, model: input.modelSelection.model, capabilities: DSH_CAPABILITIES,
        createdAt: now, updatedAt: now, lastError: null,
      };
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      let thread: OrchestrationV2ProviderThread | undefined;
      let nativeId: string | undefined;
      let native: NativeDshRuntime | undefined;
      let active = false;
      const turns: OrchestrationV2ProviderTurn[] = [];
      const messages: OrchestrationV2ConversationMessage[] = [];
      const setSession = (status: OrchestrationV2ProviderSession["status"]) =>
        Effect.gen(function* () {
          session = { ...session, status, updatedAt: yield* DateTime.now };
          yield* emit({ type: "provider_session.updated", driver: DSH_PROVIDER, providerSession: session });
        });
      yield* Effect.addFinalizer(() => Effect.promise(async () => { await native?.close(); }));
      const ensure = Effect.fn("DshAdapter.ensureThread")(function* (
        args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (thread) {
          if (thread.appThreadId !== args.threadId)
            return yield* unsupported("One DSH SDK process can own only one T3 thread");
          return thread;
        }
        if (args.existingProviderThread &&
          (args.existingProviderThread.driver !== DSH_PROVIDER ||
           args.existingProviderThread.providerInstanceId !== options.instanceId))
          return yield* unsupported("DSH session belongs to a different provider instance");
        // The persistence home must survive a newly allocated T3 providerSessionId.
        // Hash the thread identity: cross-platform, prevents path injection and shared homes.
        const directory = createHash("sha256").update(String(args.threadId)).digest("hex");
        const home = pathService.join(host.paths.stateDir, "dsh", String(options.instanceId), directory);
        yield* fs.makeDirectory(home, { recursive: true }).pipe(
          Effect.mapError(() => unsupported("Cannot create isolated DSH persistence directory")),
        );
        native = new NativeDshRuntime({
          binaryPath: options.settings.binaryPath,
          home, cwd, provider: options.settings.provider,
          model: args.modelSelection.model === "default"
            ? options.settings.model : args.modelSelection.model,
          env: options.environment,
        });
        yield* Effect.tryPromise({
          try: () => native!.start(),
          catch: (cause) => unsupported("Could not initialize DSH native SDK"),
        });
        const existing = args.existingProviderThread;
        const resumeId = existing?.nativeThreadRef?.nativeId ?? input.initialNativeThreadId;
        if (resumeId) {
          yield* Effect.tryPromise({
            try: () => native!.resumeSession(resumeId),
            catch: (cause) => unsupported("DSH session restore failed"),
          });
        }
        nativeId = resumeId ?? native.createSessionId();
        const timestamp = yield* DateTime.now;
        thread = existing
          ? { ...existing, providerSessionId: input.providerSessionId,
              nativeThreadRef: { driver: DSH_PROVIDER, nativeId, strength: "strong" },
              status: "idle", updatedAt: timestamp }
          : {
              id: ids.derive.providerThread({
                driver: DSH_PROVIDER, providerInstanceId: options.instanceId,
                nativeThreadId: nativeId,
              }),
              driver: DSH_PROVIDER, providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId, appThreadId: args.threadId,
              ownerNodeId: null, nativeThreadRef: { nativeId, strength: "strong" },
              nativeConversationHeadRef: null, status: "idle",
              firstRunOrdinal: null, lastRunOrdinal: null,
              handoffIds: [], forkedFrom: null, pendingBackgroundTasks: [],
              createdAt: timestamp, updatedAt: timestamp,
            };
        yield* emit({ type: "provider_thread.updated", driver: DSH_PROVIDER, providerThread: thread });
        return thread;
      });
      const finish = Effect.fn("DshAdapter.finish")(function* (
        args: ProviderAdapter.ProviderAdapterV2TurnInput,
        turn: OrchestrationV2ProviderTurn,
        outcome: "completed" | "failed",
        answer: string,
        detail?: string,
      ) {
        if (!thread) return;
        const ended = yield* DateTime.now;
        if (answer) {
          const identity = options.instanceId + ":" + nativeId + ":" + turn.id + ":answer";
          const messageId = ids.derive.messageFromProviderItem({ driver: DSH_PROVIDER, nativeItemId: identity });
          const itemId = ids.derive.turnItemFromProviderItem({ driver: DSH_PROVIDER, nativeItemId: identity });
          const nodeId = ids.derive.nodeFromProviderItem({ driver: DSH_PROVIDER, nativeItemId: identity });
          const message: OrchestrationV2ConversationMessage = {
            id: messageId, threadId: args.threadId, runId: args.runId,
            nodeId, role: "assistant", text: answer, attachments: [],
            streaming: false, createdBy: "agent", creationSource: "provider",
            createdAt: turn.startedAt, updatedAt: ended,
          };
          messages.push(message);
          yield* emit({ type: "message.updated", driver: DSH_PROVIDER, message });
          yield* emit({ type: "node.updated", driver: DSH_PROVIDER, node: {
            id: nodeId, threadId: args.threadId, runId: args.runId,
            parentNodeId: args.rootNodeId, rootNodeId: args.rootNodeId,
            kind: "assistant_message", status: "completed", countsForRun: false,
            providerThreadId: thread.id, providerTurnId: turn.id,
            nativeItemRef: null, runtimeRequestId: null, checkpointScopeId: null,
            startedAt: turn.startedAt, completedAt: ended,
          } });
          yield* emit({ type: "turn_item.updated", driver: DSH_PROVIDER, turnItem: {
            id: itemId, nodeId, threadId: args.threadId, runId: args.runId,
            providerThreadId: thread.id, providerTurnId: turn.id,
            nativeItemRef: null, parentItemId: null,
            ordinal: args.providerTurnOrdinal * 100 + 1,
            startedAt: turn.startedAt, updatedAt: ended, status: "completed",
            completedAt: ended, title: null, type: "assistant_message",
            messageId, text: answer, streaming: false,
          } });
        }
        const settled = { ...turn, status: outcome, completedAt: ended } satisfies OrchestrationV2ProviderTurn;
        turns.push(settled);
        yield* emit({ type: "provider_turn.updated", driver: DSH_PROVIDER, threadId: args.threadId, providerTurn: settled });
        thread = { ...thread, status: outcome === "completed" ? "idle" : "error", updatedAt: ended };
        yield* emit({ type: "provider_thread.updated", driver: DSH_PROVIDER, providerThread: thread });
        yield* setSession(outcome === "completed" ? "ready" : "error");
        if (outcome === "failed") {
          const ordinal = args.providerTurnOrdinal * 100 + 99;
          const failure = makeProviderFailure({ class: "provider_error", message: detail ?? "DSH run failed." });
          yield* emit({ type: "turn_item.updated", driver: DSH_PROVIDER, turnItem: {
            id: ids.derive.turnItemFromProviderItem({ driver: DSH_PROVIDER, nativeItemId: turn.id + ":failure" }),
            nodeId: args.rootNodeId, threadId: args.threadId, runId: args.runId,
            providerThreadId: thread.id, providerTurnId: turn.id,
            nativeItemRef: null, parentItemId: null, ordinal,
            startedAt: ended, updatedAt: ended,
            status: "failed", completedAt: ended,
            title: null, type: "error", failure,
          } });
          yield* emit({
            type: "turn.terminal", driver: DSH_PROVIDER,
            providerThreadId: thread.id, providerTurnId: turn.id,
            runOrdinal: args.runOrdinal, status: "failed", failure,
            failureItemOrdinal: ordinal, threadDisposition: "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal", driver: DSH_PROVIDER,
            providerThreadId: thread.id, providerTurnId: turn.id,
            runOrdinal: args.runOrdinal, status: "completed",
            failure: null, threadDisposition: "reusable",
          });
        }
        active = false;
      });
      return {
        instanceId: options.instanceId,
        driver: DSH_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() { return session; },
        events: Stream.fromQueue(events),
        canResumeAfterRestart: true,
        ensureThread: ensure,
        resumeThread: (args) => ensure({
          threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
          modelSelection: args.modelSelection ?? input.modelSelection,
          runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
          existingProviderThread: args.providerThread,
        }),
        startTurn: (args) => Effect.gen(function* () {
          if (active || !thread || !native || !nativeId || args.providerThread.id !== thread.id)
            return yield* unsupported("DSH session is absent or busy");
          if (args.message.attachments.length)
            return yield* unsupported("DSH attachment mapping is not yet supported");
          if (args.runtimePolicy.runtimeMode !== "approval-required")
            return yield* unsupported("Only Supervised mode is supported");
          active = true;
          const timestamp = yield* DateTime.now;
          const turn: OrchestrationV2ProviderTurn = {
            id: ids.derive.providerTurn({
              driver: DSH_PROVIDER,
              nativeTurnId: nativeId + ":" + args.runId + ":" + args.providerTurnOrdinal,
            }),
            providerThreadId: thread.id, nodeId: args.rootNodeId,
            runAttemptId: args.attemptId, nativeTurnRef: null,
            ordinal: args.providerTurnOrdinal, status: "running",
            startedAt: timestamp, completedAt: null,
          };
          yield* emit({ type: "provider_turn.updated", driver: DSH_PROVIDER, threadId: args.threadId, providerTurn: turn });
          thread = { ...thread, status: "active",
            firstRunOrdinal: thread.firstRunOrdinal ?? args.runOrdinal,
            lastRunOrdinal: args.runOrdinal, updatedAt: timestamp };
          yield* emit({ type: "provider_thread.updated", driver: DSH_PROVIDER, providerThread: thread });
          yield* setSession("running");
          yield* Effect.tryPromise({
            try: () => native!.run(nativeId!, args.message.text),
            catch: (cause) => unsupported("DSH native execution failed"),
          }).pipe(
            Effect.matchEffect({
              onFailure: (error) => finish(args, turn, "failed", "", error.message),
              onSuccess: (result) => finish(
                args, turn, result.finishReason === "stop" || result.finishReason === "end" || result.finishReason === "completed" || result.finishReason === "success" ? "completed" : "failed",
                result.finalResponse, result.finishReason ?? undefined,
              ),
            }),
            Effect.forkScoped,
          );
        }),
        steerTurn: () => Effect.fail(unsupported("DSH steering is unavailable")),
        interruptTurn: () => Effect.fail(unsupported("DSH per-session cancellation is unavailable")),
        respondToRuntimeRequest: () => Effect.fail(unsupported("DSH approvals are denied until live UI mapping is implemented")),
        readThreadSnapshot: (args) => Effect.succeed({
          providerThread: args.providerThread, providerTurns: turns, messages, runtimeRequests: [],
        }),
        rollbackThread: (args) => Effect.fail(new ProviderAdapter.ProviderAdapterRollbackThreadError({
          driver: DSH_PROVIDER, providerThreadId: args.providerThread.id, checkpointId: args.target.checkpointId,
          cause: "DSH SDK has no rewind endpoint",
        })),
        forkThread: (args) => Effect.fail(new ProviderAdapter.ProviderAdapterForkThreadError({
          driver: DSH_PROVIDER, providerThreadId: args.sourceProviderThread.id,
          cause: "DSH SDK has no fork endpoint",
        })),
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
  });
});
