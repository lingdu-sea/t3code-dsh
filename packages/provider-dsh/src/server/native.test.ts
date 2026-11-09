import { describe, expect, it } from "vitest";
import { mapDshApprovalToSdk, validatedDshNativeOptions } from "./native.ts";

const options = {
  cwd: "/tmp/dsh-test",
  home: "/tmp/dsh-home",
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  env: {},
};

describe("DSH native boundary", () => {
  it("requires a real model route before a process may start", () => {
    expect(() => validatedDshNativeOptions({ ...options, model: " " })).toThrow(/model ID/);
    expect(() => validatedDshNativeOptions({ ...options, provider: "" })).toThrow(/model provider/);
  });
  it("preserves exact configured model IDs", () => {
    expect(validatedDshNativeOptions({ ...options, model: " abc/model " }).model).toBe("abc/model");
  });
  it("maps only one-shot permission outcomes", () => {
    expect(mapDshApprovalToSdk("allowed-once")).toEqual({ outcome: "allowed-once" });
    expect(mapDshApprovalToSdk("rejected")).toEqual({ outcome: "rejected" });
    expect(mapDshApprovalToSdk("cancelled")).toEqual({ outcome: "cancelled" });
  });
});
