import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { DshSettings } from "./settings.ts";

export const dshClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("dsh"),
  label: "DeepSeek Harness",
  modelFamilies: ["DeepSeek"],
  settingsSchema: DshSettings,
  // Simple, package-owned icon; no per-driver client or mobile branches.
  icon: {
    viewBox: "0 0 64 64",
    fill: { light: "#20478D", dark: "#83B6FF" },
    paths: [
      { d: "M12 8h15c18 0 29 10 29 24S45 56 27 56H12V8Zm15 9h-5v30h5c12 0 19-6 19-15S39 17 27 17Z", fillRule: "evenodd" },
    ],
  },
});
