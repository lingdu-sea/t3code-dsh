import { describe, expect, it } from "vite-plus/test";
import { inheritedDshLaunchEnvironment } from "./isolatedEnvironment.ts";

describe("DSH subprocess inherited environment", () => {
  it("keeps only process-launch necessities; strips provider secrets", () => {
    const result = inheritedDshLaunchEnvironment({
      PATH: "/bin", LANG: "en_US.UTF-8", TMPDIR: "/tmp",
      DEEPSEEK_API_KEY: "secret", OPENAI_API_KEY: "secret",
      ANTHROPIC_API_KEY: "secret", GITHUB_TOKEN: "secret",
      AWS_ACCESS_KEY_ID: "secret", AWS_SECRET_ACCESS_KEY: "secret",
      DATABASE_URL: "postgres://secret", NODE_OPTIONS: "--require /tmp/untrusted.js",
      DSH_HOME: "/somebody-else",
    });
    expect(result).toEqual({ PATH: "/bin", LANG: "en_US.UTF-8", TMPDIR: "/tmp" });
    expect(result.DEEPSEEK_API_KEY).toBeUndefined();
    expect(result.NODE_OPTIONS).toBeUndefined();
    expect(result.DSH_HOME).toBeUndefined();
  });

  it("allows Windows casing for launch variables without inheriting secrets", () => {
    const result = inheritedDshLaunchEnvironment({
      Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp",
      Github_Token: "hidden", home: "C:\\Users\\other",
    });
    expect(result).toEqual({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
  });

  it("drops unknown variables and empty or undefined values without mutating the source", () => {
    const inherited = { PATH: "", FOO: "bar", TMP: undefined };
    expect(inheritedDshLaunchEnvironment(inherited)).toEqual({ PATH: "" });
    expect(inherited).toEqual({ PATH: "", FOO: "bar", TMP: undefined });
  });
});
