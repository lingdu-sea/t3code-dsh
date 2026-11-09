/**
 * Native DeepSeek Harness SDK integration, deliberately independent of ACP.
 *
 * One NativeDshRuntime owns one SDK subprocess. The T3 adapter must create a
 * separate runtime for each T3 provider session, not share a mutable client
 * across provider instances. Process termination is a last-resort stop:
 * DSH SDK 0.2.2-rc.1 has no per-session cancel/close methods.
 */
import {
  DeepSeekHarness,
  type HarnessNotification,
  type RunResult,
  type SdkUserQuestionRequest,
  type SdkUserQuestionResult,
} from "@deepseek-ai/dsh-sdk-client";

export type DshApprovalDecision = "allowed-once" | "rejected" | "cancelled";

export interface DshNativeOptions {
  /** Absolute path to a built DSH Node CLI module (not a shell executable). */
  readonly binaryPath?: string;
  readonly home: string;
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  /** Fully resolved and filtered environment, never raw credentials from another instance. */
  readonly env: NodeJS.ProcessEnv;
}

export interface DshApprovalRequest {
  readonly sessionId: string;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
}

export interface DshNativeCallbacks {
  readonly onApproval?: (request: DshApprovalRequest) => Promise<DshApprovalDecision>;
  readonly onQuestion?: (
    request: SdkUserQuestionRequest,
    context: { readonly signal: AbortSignal },
  ) => Promise<SdkUserQuestionResult>;
  readonly onNotification?: (notification: HarnessNotification) => void;
}

export function validatedDshNativeOptions(input: DshNativeOptions): DshNativeOptions {
  const provider = input.provider.trim();
  const model = input.model.trim();
  if (!provider || !model) throw new Error("DSH requires an explicit model provider and model ID.");
  if (!input.home || !input.cwd) throw new Error("DSH requires a dedicated home and workspace.");
  return { ...input, provider, model };
}

export function mapDshApprovalToSdk(decision: DshApprovalDecision): { outcome: DshApprovalDecision } {
  return { outcome: decision };
}

export class NativeDshRuntime {
  private readonly harness: DeepSeekHarness;
  private readonly callbacks: DshNativeCallbacks;
  private closed = false;
  private active = false;

  constructor(input: DshNativeOptions, callbacks: DshNativeCallbacks = {}) {
    const config = validatedDshNativeOptions(input);
    this.callbacks = callbacks;
    this.harness = new DeepSeekHarness({
      profile: "sdk",
      ...(config.binaryPath ? { dshBin: config.binaryPath } : {}),
      dshHome: config.home,
      cwd: config.cwd,
      processCwd: config.cwd,
      provider: config.provider,
      model: config.model,
      env: { ...config.env },
      approvalRequests: true,
      // A missing handler must reject, never fall back to an in-runtime prompt.
      onUserQuestion: async (request, context) =>
        this.callbacks.onQuestion
          ? this.callbacks.onQuestion(request, context)
          : { cancelled: true },
    });
    // Install the approval handler before the initialize handshake.

  }

  /** Stable SDK identity for the T3 provider thread. */
  createSessionId(): string {
    if (this.closed) throw new Error("DSH runtime is closed.");
    return this.harness.session().id;
  }

  get isClosed(): boolean { return this.closed; }
  get isActive(): boolean { return this.active; }

  async start(): Promise<void> {
    if (this.closed) throw new Error("DSH runtime is closed.");
    // Side effects belong in start, never in a constructor. The SDK may
    // replace its client after a failed handshake; register on every start.
    this.harness.client.start();
    this.harness.client.onRequest(async (method, params) => {
      if (method !== "approval/request") {
        throw new Error("Unsupported DSH native request");
      }
      if (!this.callbacks.onApproval) return { outcome: "rejected" };
      const request = params as unknown as DshApprovalRequest;
      try {
        return mapDshApprovalToSdk(await this.callbacks.onApproval(request));
      } catch {
        return { outcome: "rejected" };
      }
    });
    await this.harness.start();
  }

  /** Reopening an old persisted DSH session never silently creates a new one. */
  async resumeSession(sessionId: string): Promise<void> {
    if (this.closed || this.active) throw new Error("DSH runtime is unavailable.");
    await this.harness.resumeSession(sessionId);
  }

  /** Creates the named SDK session lazily; the first prompt persists its identity. */
  async run(sessionId: string, prompt: string): Promise<RunResult> {
    if (this.closed) throw new Error("DSH runtime is closed.");
    if (this.active) throw new Error("DSH already has an active turn.");
    if (!sessionId.trim() || !prompt.trim()) throw new Error("DSH requires a session ID and a prompt.");
    this.active = true;
    try {
      return await this.harness.session(sessionId).run(prompt, {
        onNotification: (notification) => this.callbacks.onNotification?.(notification),
      });
    } finally {
      this.active = false;
    }
  }

  /**
   * Stops this isolated SDK process, including any child sessions. It does NOT
   * mean DSH supports cancelling a single session on a shared SDK process.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.harness.close();
  }
}
