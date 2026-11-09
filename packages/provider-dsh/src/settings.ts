// Browser-safe instance settings. Do not import the Node-only DSH SDK here.
import { CustomModelSetting, makeBinaryPathSetting, makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DshSettings = makeProviderSettingsSchema({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  binaryPath: makeBinaryPathSetting("").pipe(
    Schema.annotateKey({
      title: "DSH Node entry (optional)",
      description: "Advanced: absolute path to a built dsh Node CLI entry module. Leave empty to use the SDK-matched DSH runtime.",
      providerSettingsForm: { placeholder: "/absolute/path/to/dsh/dist/bin.js", clearWhenEmpty: "omit" },
    }),
  ),
  provider: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("deepseek-official")),
    Schema.annotateKey({
      title: "Model provider",
      description: "DSH native model route (for example deepseek-official).",
    }),
  ),
  model: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("deepseek-v4-flash")),
    Schema.annotateKey({
      title: "Model ID",
      description: "Exact DSH model ID. Confirm availability with your DSH model configuration.",
    }),
  ),
  customModels: Schema.Array(CustomModelSetting).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
}, { order: ["binaryPath", "provider", "model"] });
export type DshSettings = typeof DshSettings.Type;
