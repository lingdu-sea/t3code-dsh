import {
  ProviderDriverKind,
  TextGenerationError,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { DshSettings } from "../settings.ts";
import { makeDshAdapterV2 } from "./adapter.ts";

const DRIVER = ProviderDriverKind.make("dsh");
const decodeSettings = Schema.decodeSync(DshSettings);
export type DshDriverEnv =
  | ProviderHost.ProviderHost
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HostProcess.HomeDirectory
  | HostProcess.Platform;

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
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
    const snapshotFor = (installed: boolean, version: string | null, status: "warning" | "ready" | "error", message: string) =>
      Effect.gen(function* () {
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
      const probe = yield* spawnAndCollect(settings.binaryPath,
        ChildProcess.make(settings.binaryPath, ["--version"], {
          env, cwd: host.paths.cwd,
        })).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeoutOption(5_000),
          Effect.result,
        );
      if (Result.isFailure(probe)) {
        return yield* snapshotFor(false, null, "error", "DSH executable is unavailable or its version probe failed.");
      }
      if (Option.isNone(probe.success)) {
        return yield* snapshotFor(false, null, "error", "DSH version probe timed out.");
      }
      const output = probe.success.value;
      const version = parseGenericCliVersion(output.stdout + "\n" + output.stderr);
      return yield* snapshotFor(output.code === 0, version,
        output.code === 0 ? "ready" : "error",
        output.code === 0
          ? "DSH CLI detected. Runtime model authentication is verified on first session."
          : "DSH version command returned a nonzero status.");
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
