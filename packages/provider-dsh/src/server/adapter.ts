import {
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ConversationMessage,
  type ProviderInstanceId,
  type RuntimeRequestId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createHash } from "node:crypto";
import type { SdkUserQuestionRequest, SdkUserQuestionResult } from "@deepseek-ai/dsh-sdk-client";
import { mapT3AnswersToDsh } from "./questionMapping.ts";
import { readNativeDshEvent, classifyDshTerminal, type NativeDshEvent } from "./nativeEvents.ts";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { DshSettings } from "../settings.ts";
import { NativeDshRuntime, type DshApprovalRequest, type DshApprovalDecision } from "./native.ts";

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
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
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
      let activeTurn: { args: ProviderAdapter.ProviderAdapterV2TurnInput; turn: OrchestrationV2ProviderTurn } | null = null;
      const turns: OrchestrationV2ProviderTurn[] = [];
      const messages: OrchestrationV2ConversationMessage[] = [];
      type Approval = {
        readonly request: OrchestrationV2RuntimeRequest;
        readonly node: OrchestrationV2ExecutionNode;
        readonly item: OrchestrationV2TurnItem;
        readonly resolve: (choice: DshApprovalDecision) => void;
      };
      const pendingApprovals = new Map<RuntimeRequestId, Approval>();
      type Question = {
        readonly incoming: SdkUserQuestionRequest;
        readonly request: OrchestrationV2RuntimeRequest;
        readonly node: OrchestrationV2ExecutionNode;
        readonly item: OrchestrationV2TurnItem;
        readonly resolve: (answer: SdkUserQuestionResult) => void;
      };
      const pendingQuestions = new Map<RuntimeRequestId, Question>();
      let requestOrdinal = 0;
      // Called from the native JSON-RPC host request handler. All human
      // approvals are one-shot, and no subagent approval is silently granted.
      type ToolRecord = {
        readonly itemId: ReturnType<typeof ids.derive.turnItemFromProviderItem>;
        readonly nodeId: ReturnType<typeof ids.derive.nodeFromProviderItem>;
        readonly nativeRef: { readonly driver: typeof DSH_PROVIDER; readonly nativeId: string; readonly strength: "strong" };
        readonly startedAt: DateTime.Utc;
        readonly name: string;
        readonly arguments: string;
        readonly ordinal: number;
      };
      const toolRecords = new Map<string, ToolRecord>();
      let eventOrdinal = 0;
      let assistantWasEmitted = false;
      let nativeEventError: unknown = undefined;
      let nativeEventChain: Promise<void> = Promise.resolve();
      const processNativeEvent = (normalized: NativeDshEvent) => Effect.gen(function* () {
        const owner = activeTurn;
        const current = thread;
        if (!owner || !current) return;
        if (normalized.kind === "turn-end") return;
        const timestamp = yield* DateTime.now;
        if (normalized.kind === "tool-start") {
          if (toolRecords.has(normalized.callId)) return;
          const identity = String(options.instanceId) + ":" + String(current.id) + ":" + normalized.callId;
          const record: ToolRecord = {
            itemId: ids.derive.turnItemFromProviderItem({ driver: DSH_PROVIDER, nativeItemId: identity }),
            nodeId: ids.derive.nodeFromProviderItem({ driver: DSH_PROVIDER, nativeItemId: identity }),
            nativeRef: { driver: DSH_PROVIDER, nativeId: normalized.callId, strength: "strong" },
            startedAt: timestamp, name: normalized.name, arguments: normalized.arguments,
            ordinal: owner.args.providerTurnOrdinal * 100 + (++eventOrdinal),
          };
          toolRecords.set(normalized.callId, record);
          yield* emit({ type: "node.updated", driver: DSH_PROVIDER, node: {
            id: record.nodeId, threadId: owner.args.threadId, runId: owner.args.runId,
            parentNodeId: owner.args.rootNodeId, rootNodeId: owner.args.rootNodeId,
            kind: "tool_call", status: "running", countsForRun: false,
            providerThreadId: current.id, providerTurnId: owner.turn.id,
            nativeItemRef: record.nativeRef, runtimeRequestId: null, checkpointScopeId: null,
            startedAt: timestamp, completedAt: null,
          } });
          yield* emit({ type: "turn_item.updated", driver: DSH_PROVIDER, turnItem: {
            id: record.itemId, nodeId: record.nodeId,
            threadId: owner.args.threadId, runId: owner.args.runId,
            providerThreadId: current.id, providerTurnId: owner.turn.id,
            nativeItemRef: record.nativeRef, parentItemId: null,
            ordinal: record.ordinal, startedAt: timestamp, updatedAt: timestamp,
            status: "running", completedAt: null, title: record.name,
            type: "dynamic_tool", toolName: record.name, input: record.arguments,
          } });
          return;
        }
        if (normalized.kind === "tool-end") {
          const record = toolRecords.get(normalized.callId);
          if (!record) return;
          const status = normalized.isError ? "failed" as const : "completed" as const;
          yield* emit({ type: "node.updated", driver: DSH_PROVIDER, node: {
            id: record.nodeId, threadId: owner.args.threadId, runId: owner.args.runId,
            parentNodeId: owner.args.rootNodeId, rootNodeId: owner.args.rootNodeId,
            kind: "tool_call", status, countsForRun: false,
            providerThreadId: current.id, providerTurnId: owner.turn.id,
            nativeItemRef: record.nativeRef, runtimeRequestId: null, checkpointScopeId: null,
            startedAt: record.startedAt, completedAt: timestamp,
          } });
          yield* emit({ type: "turn_item.updated", driver: DSH_PROVIDER, turnItem: {
            id: record.itemId, nodeId: record.nodeId,
            threadId: owner.args.threadId, runId: owner.args.runId,
            providerThreadId: current.id, providerTurnId: owner.turn.id,
            nativeItemRef: record.nativeRef, parentItemId: null, ordinal: record.ordinal,
            startedAt: record.startedAt, updatedAt: timestamp,
            status, completedAt: timestamp, title: record.name,
            type: "dynamic_tool", toolName: record.name, input: record.arguments,
            output: normalized.text,
          } });
          toolRecords.delete(normalized.callId);
          return;
        }
        if (normalized.kind === "assistant" && normalized.text.trim()) {
          assistantWasEmitted = true;
          const identity = String(options.instanceId) + ":" + String(current.id) + ":assistant:" + normalized.key;
          const messageId = ids.derive.messageFromProviderItem({ driver: DSH_PROVIDER, nativeItemId: identity });
          const nodeId = ids.derive.nodeFromProviderItem({ driver: DSH_PROVIDER, nativeItemId: identity });
          const message: OrchestrationV2ConversationMessage = {
            id: messageId, threadId: owner.args.threadId, runId: owner.args.runId,
            nodeId, role: "assistant", text: normalized.text,
            attachments: [], streaming: false, createdBy: "agent", creationSource: "provider",
            createdAt: timestamp, updatedAt: timestamp,
          };
          messages.push(message);
          yield* emit({ type: "message.updated", driver: DSH_PROVIDER, message });
          yield* emit({ type: "node.updated", driver: DSH_PROVIDER, node: {
            id: nodeId, threadId: owner.args.threadId, runId: owner.args.runId,
            parentNodeId: owner.args.rootNodeId, rootNodeId: owner.args.rootNodeId,
            kind: "assistant_message", status: "completed", countsForRun: false,
            providerThreadId: current.id, providerTurnId: owner.turn.id,
            nativeItemRef: null, runtimeRequestId: null, checkpointScopeId: null,
            startedAt: timestamp, completedAt: timestamp,
          } });
          yield* emit({ type: "turn_item.updated", driver: DSH_PROVIDER, turnItem: {
            id: ids.derive.turnItemFromProviderItem({ driver: DSH_PROVIDER, nativeItemId: identity }),
            nodeId, threadId: owner.args.threadId, runId: owner.args.runId,
            providerThreadId: current.id, providerTurnId: owner.turn.id,
            nativeItemRef: null, parentItemId: null,
            ordinal: owner.args.providerTurnOrdinal * 100 + (++eventOrdinal),
            startedAt: timestamp, updatedAt: timestamp, status: "completed", completedAt: timestamp,
            title: null, type: "assistant_message",
            messageId, text: normalized.text, streaming: false,
          } });
        }
      });
      const onNotification = (notification: HarnessNotification): void => {
        if (!nativeId) return;
        const normalized = readNativeDshEvent(notification, nativeId);
        if (!normalized) return;
        // Serializes dependent tool-start/tool-result events and ensures the
        // terminal waits for projection. A conversion failure fails the turn.
        nativeEventChain = nativeEventChain.then(() =>
          Effect.runPromise(processNativeEvent(normalized)),
        ).catch((error: unknown) => {
          nativeEventError = error;
        });
      };
      const onApproval = async (incoming: DshApprovalRequest): Promise<DshApprovalDecision> => {
        const owner = activeTurn;
        const currentThread = thread;
        if (!owner || !currentThread || !nativeId || incoming.sessionId !== nativeId) {
          return "rejected";
        }
        try {
          const requestId = await Effect.runPromise(ids.allocate.runtimeRequest({
            driver: DSH_PROVIDER,
            providerTurnId: owner.turn.id,
            ...(incoming.callId ? { nativeRequestId: incoming.callId } : {}),
          }));
          const createdAt = await Effect.runPromise(DateTime.now);
          const nodeId = ids.derive.approvalNode({ requestId });
          const request: OrchestrationV2RuntimeRequest = {
            id: requestId, nodeId, providerTurnId: owner.turn.id,
            nativeRequestRef: incoming.callId
              ? { driver: DSH_PROVIDER, nativeId: incoming.callId, strength: "weak" }
              : null,
            kind: "permission", status: "pending",
            responseCapability: { type: "live", providerSessionId: input.providerSessionId },
            createdAt, resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId, threadId: owner.args.threadId, runId: owner.args.runId,
            parentNodeId: owner.args.rootNodeId, rootNodeId: owner.args.rootNodeId,
            kind: "approval_request", status: "waiting", countsForRun: false,
            providerThreadId: currentThread.id, providerTurnId: owner.turn.id,
            nativeItemRef: null, runtimeRequestId: requestId, checkpointScopeId: null,
            startedAt: createdAt, completedAt: null,
          };
          const item: OrchestrationV2TurnItem = {
            id: ids.derive.approvalTurnItem({ requestId }),
            nodeId, threadId: owner.args.threadId, runId: owner.args.runId,
            providerThreadId: currentThread.id, providerTurnId: owner.turn.id,
            nativeItemRef: null, parentItemId: null,
            ordinal: owner.args.providerTurnOrdinal * 100 + 50 + (++requestOrdinal),
            startedAt: createdAt, updatedAt: createdAt,
            status: "waiting", completedAt: null, title: null,
            type: "approval_request", requestId, requestKind: "permission",
            prompt: (incoming.reason || ("DSH tool permission: " + incoming.toolName)).slice(0, 512),
            options: [
              { decision: "accept", label: "Allow once" },
              { decision: "decline", label: "Deny" },
            ],
          };
          let finish!: (choice: DshApprovalDecision) => void;
          const answer = new Promise<DshApprovalDecision>((resolve) => { finish = resolve; });
          pendingApprovals.set(requestId, { request, node, item, resolve: finish });
          await Effect.runPromise(emit({ type: "runtime_request.updated", driver: DSH_PROVIDER, threadId: owner.args.threadId, runtimeRequest: request }));
          await Effect.runPromise(emit({ type: "node.updated", driver: DSH_PROVIDER, node }));
          await Effect.runPromise(emit({ type: "turn_item.updated", driver: DSH_PROVIDER, turnItem: item }));
          if (activeTurn === owner) await Effect.runPromise(setSession("waiting"));
          return await answer;
        } catch {
          return "rejected";
        }
      };
      const onQuestion = async (
        incoming: SdkUserQuestionRequest,
        context: { readonly signal: AbortSignal },
      ): Promise<SdkUserQuestionResult> => {
        const owner = activeTurn;
        const currentThread = thread;
        if (!owner || !currentThread || !nativeId ||
            incoming.sessionId !== nativeId || context.signal.aborted) {
          return { cancelled: true };
        }
        try {
          const requestId = await Effect.runPromise(ids.allocate.runtimeRequest({
            driver: DSH_PROVIDER, providerTurnId: owner.turn.id,
            nativeRequestId: incoming.requestId,
          }));
          const createdAt = await Effect.runPromise(DateTime.now);
          const nodeId = ids.derive.approvalNode({ requestId });
          const request: OrchestrationV2RuntimeRequest = {
            id: requestId, nodeId, providerTurnId: owner.turn.id,
            nativeRequestRef: { driver: DSH_PROVIDER, nativeId: incoming.requestId, strength: "strong" },
            kind: "user_input", status: "pending",
            responseCapability: { type: "live", providerSessionId: input.providerSessionId },
            createdAt, resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId, threadId: owner.args.threadId, runId: owner.args.runId,
            parentNodeId: owner.args.rootNodeId, rootNodeId: owner.args.rootNodeId,
            kind: "user_input_request", status: "waiting", countsForRun: false,
            providerThreadId: currentThread.id, providerTurnId: owner.turn.id,
            nativeItemRef: null, runtimeRequestId: requestId, checkpointScopeId: null,
            startedAt: createdAt, completedAt: null,
          };
          const item: OrchestrationV2TurnItem = {
            id: ids.derive.approvalTurnItem({ requestId }), nodeId,
            threadId: owner.args.threadId, runId: owner.args.runId,
            providerThreadId: currentThread.id, providerTurnId: owner.turn.id,
            nativeItemRef: null, parentItemId: null,
            ordinal: owner.args.providerTurnOrdinal * 100 + 50 + (++requestOrdinal),
            startedAt: createdAt, updatedAt: createdAt,
            status: "waiting", completedAt: null, title: null,
            type: "user_input_request", requestId,
            questions: incoming.questions.map((q, i) => ({
              id: q.id.trim() || "question-" + i,
              header: q.header?.trim() || "Question",
              question: q.question.trim() || "Please provide input",
              options: (q.options ?? []).map((choice) => ({
                label: choice.label,
                description: choice.description?.trim() || choice.label,
              })),
              multiSelect: q.multiSelect ?? false, allowCustomAnswer: true, required: true,
            })),
          };
          let finish!: (value: SdkUserQuestionResult) => void;
          const answer = new Promise<SdkUserQuestionResult>((resolve) => { finish = resolve; });
          const pending: Question = { incoming, request, node, item, resolve: finish };
          pendingQuestions.set(requestId, pending);
          const onAbort = () => {
            if (pendingQuestions.get(requestId) !== pending) return;
            pendingQuestions.delete(requestId);
            finish({ cancelled: true });
          };
          context.signal.addEventListener("abort", onAbort, { once: true });
          try {
            await Effect.runPromise(emit({ type: "runtime_request.updated", driver: DSH_PROVIDER, threadId: owner.args.threadId, runtimeRequest: request }));
            await Effect.runPromise(emit({ type: "node.updated", driver: DSH_PROVIDER, node }));
            await Effect.runPromise(emit({ type: "turn_item.updated", driver: DSH_PROVIDER, turnItem: item }));
            if (activeTurn === owner) await Effect.runPromise(setSession("waiting"));
            return await answer;
          } finally {
            context.signal.removeEventListener("abort", onAbort);
          }
        } catch {
          return { cancelled: true };
        }
      };
      const setSession = (status: OrchestrationV2ProviderSession["status"]) =>
        Effect.gen(function* () {
          session = { ...session, status, updatedAt: yield* DateTime.now };
          yield* emit({ type: "provider_session.updated", driver: DSH_PROVIDER, providerSession: session });
        });
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        for (const pending of pendingApprovals.values()) pending.resolve("cancelled");
        pendingApprovals.clear();
        for (const pending of pendingQuestions.values()) pending.resolve({ cancelled: true });
        pendingQuestions.clear();
        await native?.close();
      }));
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
        }, { onApproval, onQuestion, onNotification });
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
        if (answer && !assistantWasEmitted) {
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
        // Settle every stale host request before the terminal event.
        for (const [requestId, pending] of pendingApprovals) {
          pendingApprovals.delete(requestId);
          pending.resolve("cancelled");
          yield* emit({ type: "runtime_request.updated", driver: DSH_PROVIDER,
            threadId: args.threadId,
            runtimeRequest: { ...pending.request, status: "cancelled",
              resolvedAt: ended, responseCapability: {
                type: "not_resumable", reason: "DSH turn has ended",
              } },
          });
          yield* emit({ type: "node.updated", driver: DSH_PROVIDER,
            node: { ...pending.node, status: "cancelled", completedAt: ended } });
          yield* emit({ type: "turn_item.updated", driver: DSH_PROVIDER,
            turnItem: { ...pending.item, status: "cancelled",
              completedAt: ended, updatedAt: ended } });
        }
        for (const [requestId, pending] of pendingQuestions) {
          pendingQuestions.delete(requestId);
          pending.resolve({ cancelled: true });
          yield* emit({ type: "runtime_request.updated", driver: DSH_PROVIDER,
            threadId: args.threadId,
            runtimeRequest: { ...pending.request, status: "cancelled",
              resolvedAt: ended, responseCapability: {
                type: "not_resumable", reason: "DSH turn has ended",
              } },
          });
          yield* emit({ type: "node.updated", driver: DSH_PROVIDER,
            node: { ...pending.node, status: "cancelled", completedAt: ended } });
          yield* emit({ type: "turn_item.updated", driver: DSH_PROVIDER,
            turnItem: { ...pending.item, status: "cancelled",
              completedAt: ended, updatedAt: ended } });
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
        activeTurn = null;
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
          if (activeTurn || !thread || !native || !nativeId || args.providerThread.id !== thread.id)
            return yield* unsupported("DSH session is absent or busy");
          if (args.message.attachments.length)
            return yield* unsupported("DSH attachment mapping is not yet supported");
          if (args.runtimePolicy.runtimeMode !== "approval-required")
            return yield* unsupported("Only Supervised mode is supported");
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
          assistantWasEmitted = false;
          nativeEventError = undefined;
          toolRecords.clear();
          activeTurn = { args, turn };
          yield* emit({ type: "provider_turn.updated", driver: DSH_PROVIDER, threadId: args.threadId, providerTurn: turn });
          thread = { ...thread, status: "active",
            firstRunOrdinal: thread.firstRunOrdinal ?? args.runOrdinal,
            lastRunOrdinal: args.runOrdinal, updatedAt: timestamp };
          yield* emit({ type: "provider_thread.updated", driver: DSH_PROVIDER, providerThread: thread });
          yield* setSession("running");
          yield* Effect.tryPromise({
            try: async () => {
              const result = await native!.run(nativeId!, args.message.text);
              await nativeEventChain;
              if (nativeEventError !== undefined) throw new Error("DSH event projection failed");
              return result;
            },
            catch: () => unsupported("DSH native execution or event projection failed"),
          }).pipe(
            Effect.matchEffect({
              onFailure: (error) => finish(args, turn, "failed", "", error.message),
              onSuccess: (result) => finish(
                args, turn, classifyDshTerminal(result.finishReason) === "completed" ? "completed" : "failed",
                result.finalResponse, result.finishReason ?? undefined,
              ),
            }),
            Effect.forkScoped,
          );
        }),
        steerTurn: () => Effect.fail(unsupported("DSH steering is unavailable")),
        interruptTurn: () => Effect.fail(unsupported("DSH per-session cancellation is unavailable")),
        respondToRuntimeRequest: (reply) => Effect.gen(function* () {
          const question = pendingQuestions.get(reply.requestId);
          if (question) {
            pendingQuestions.delete(reply.requestId);
            const resolvedAt = yield* DateTime.now;
            const response = mapT3AnswersToDsh(question.incoming.questions, reply.answers);
            const cancelled = "cancelled" in response;
            yield* emit({ type: "runtime_request.updated", driver: DSH_PROVIDER,
              threadId: input.threadId,
              runtimeRequest: { ...question.request, status: cancelled ? "cancelled" : "resolved",
                resolvedAt, ...(reply.answers ? { answers: reply.answers } : {}),
                responseCapability: { type: "not_resumable", reason: "User input submitted" },
              },
            });
            yield* emit({ type: "node.updated", driver: DSH_PROVIDER,
              node: { ...question.node, status: cancelled ? "cancelled" : "completed",
                completedAt: resolvedAt },
            });
            yield* emit({ type: "turn_item.updated", driver: DSH_PROVIDER,
              turnItem: { ...question.item, status: cancelled ? "cancelled" : "completed",
                completedAt: resolvedAt, updatedAt: resolvedAt },
            });
            question.resolve(response);
            if (activeTurn && pendingQuestions.size + pendingApprovals.size === 0)
              yield* setSession("running");
            return;
          }
          const pending = pendingApprovals.get(reply.requestId);
          if (!pending) return yield* unsupported("DSH request is no longer pending");
          pendingApprovals.delete(reply.requestId);
          const resolvedAt = yield* DateTime.now;
          const decision = reply.decision === "accept"
            ? "allowed-once" : reply.decision === "cancel" ? "cancelled" : "rejected";
          yield* emit({ type: "runtime_request.updated", driver: DSH_PROVIDER,
            threadId: input.threadId,
            runtimeRequest: { ...pending.request, status: "resolved", resolvedAt,
              ...(reply.decision ? { decision: reply.decision } : {}),
              responseCapability: { type: "not_resumable", reason: "Decision submitted" },
            },
          });
          yield* emit({ type: "node.updated", driver: DSH_PROVIDER, node: {
            ...pending.node, status: "completed", completedAt: resolvedAt,
          } });
          yield* emit({ type: "turn_item.updated", driver: DSH_PROVIDER, turnItem: {
            ...pending.item, status: "completed", completedAt: resolvedAt, updatedAt: resolvedAt,
          } });
          pending.resolve(decision);
          if (activeTurn && pendingQuestions.size + pendingApprovals.size === 0)
            yield* setSession("running");
        }),
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
