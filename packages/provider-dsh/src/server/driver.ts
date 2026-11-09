import {
  ProviderDriverKind,
  TextGenerationError,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeProviderSnapshotSettingsSource,
  haveProviderSnapshotSettingsChanged,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  buildServerProvider,
  providerModelsFromSettings,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { DshSettings } from "../settings.ts";
import { makeDshAdapterV2 } from "./adapter.ts";
import { NativeDshRuntime } from "./native.ts";

const DRIVER = ProviderDriverKind.make("dsh");
const decodeSettings = Schema.decodeSync(DshSettings);
export type DshDriverEnv =
  | ProviderHost.ProviderHost
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem;

const maintenance = {
  provider: DRIVER,
  packageName: null,
  update: null,
  manualCommand: "Update DeepSeek Harness using the installer that owns the CLI",
} as const;

const unavailable = (operation: keyof ProviderTextGeneration) =>
  Effect.fail(new TextGenerationError({
    operation,
    detail: "DSH provider-owned text generation is not yet implemented; choose an existing provider for this action.",
  }));

const textGeneration: ProviderTextGeneration = {
  generateTranscriptionPostProcessing: () => unavailable("generateTranscriptionPostProcessing"),
  generateCommitMessage: () => unavailable("generateCommitMessage"),
  generatePrContent: () => unavailable("generatePrContent"),
  generateBranchName: () => unavailable("generateBranchName"),
  generateThreadTitle: () => unavailable("generateThreadTitle"),
  generateReviewGuide: () => unavailable("generateReviewGuide"),
};

function makeModelRows(config: DshSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [{
      slug: config.model, name: config.model,
      isDefault: true, isCustom: false, capabilities: {},
    }],
    config.customModels,
    {},
  );
}

export const DshDriver: ProviderDriver<DshSettings, DshDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "DeepSeek Harness", supportsMultipleInstances: true },
  configSchema: DshSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("DshDriver.create")(function* ({
    instanceId, displayName, accentColor, environment, enabled, config,
  }) {
    const host = yield* ProviderHost.ProviderHost;
    const fs = yield* FileSystem.FileSystem;
    const settings = { ...config, enabled } satisfies DshSettings;
    // mergeProviderInstanceEnvironment returns process.env itself when no overrides
    // exist. Clone before stripping inherited credentials, never mutate the host.
    const env = { ...(yield* mergeProviderInstanceEnvironment(environment)) };
    const explicitlyBound = new Set(environment.map((variable) => variable.name.toUpperCase()));
    // A DSH instance must not silently inherit credentials from another provider.
    for (const key of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      if (!explicitlyBound.has(key)) delete env[key];
    }
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER, instanceId,
    });
    const stamp = withInstanceIdentity({
      instanceId, driverKind: DRIVER, displayName, accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const snapshotFor = Effect.fn("DshDriver.snapshotFor")(function* (
      installed: boolean, version: string | null,
      status: "warning" | "ready" | "error", message: string,
    ) {
        return stamp(buildServerProvider({
          presentation: {
            displayName: "DeepSeek Harness",
            showInteractionModeToggle: false,
            supportedRuntimeModes: ["approval-required"],
            reportsContextWindow: false,
          },
          enabled: settings.enabled,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          models: makeModelRows(settings),
          probe: {
            installed, version, status,
            auth: { status: "unknown" },
            message,
          },
        }));
    });
    const checkProvider = Effect.gen(function* () {
      if (!settings.enabled) {
        return yield* snapshotFor(false, null, "warning", "DSH is disabled.");
      }
      // A CLI --version check is insufficient: the SDK ships its own
      // same-version Node entry, while binaryPath is an optional module path.
      // Use a separate probe home so real sessions remain untouched.
      const probeHome = host.paths.stateDir + "/dsh/probe/" + instanceId;
      const homeResult = yield* fs.makeDirectory(probeHome, { recursive: true }).pipe(Effect.result);
      if (homeResult._tag === "Failure")
        return yield* snapshotFor(false, null, "error", "Cannot create DSH SDK probe directory.");
      const probe = yield* Effect.tryPromise({
        try: async () => {
          let runtime: NativeDshRuntime | undefined;
          try {
            runtime = new NativeDshRuntime({
              ...(settings.binaryPath ? { binaryPath: settings.binaryPath } : {}),
              home: probeHome, cwd: host.paths.cwd, env,
              provider: settings.provider, model: settings.model,
            });
            await runtime.start();
          } finally {
            await runtime?.close();
          }
        },
        catch: (cause) => new ProviderDriverError({
          driver: DRIVER, instanceId,
          detail: "DSH SDK runtime handshake failed", cause,
        }),
      }).pipe(Effect.timeoutOption(16_000), Effect.result);
      if (probe._tag === "Failure") {
        return yield* snapshotFor(false, null, "error", "DSH SDK handshake failed; check installation, model route and credentials.");
      }
      if (probe.success._tag === "None") {
        return yield* snapshotFor(false, null, "error", "DSH SDK initialization timed out.");
      }
      return yield* snapshotFor(true, null, "ready", "DSH SDK handshake succeeded; model inference and account authorization are not yet verified.");
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(settings);
    const managed = yield* makeManagedServerProvider({
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: () => snapshotFor(false, null, "warning", "DSH health check pending."),
      checkProvider,
      refreshOnInterval: false,
    }).pipe(Effect.mapError((cause) => new ProviderDriverError({
      driver: DRIVER, instanceId,
      detail: "Could not create DSH provider snapshot", cause,
    })));
    const orchestrationAdapter = yield* makeDshAdapterV2({
      instanceId, settings, environment: env,
    });
    return {
      instanceId, driverKind: DRIVER, continuationIdentity,
      displayName, accentColor, enabled,
      snapshot: managed, orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
