import { describe, expect, it } from "vitest";
import { readSettings, ttlSettingFor } from "./settings";

describe("readSettings", () => {
  it("uses the defaults while settings load", () => {
    expect(readSettings(undefined)).toEqual({
      ttl: { "claude-code": "auto", codex: "auto", pi: "auto" },
      warnMs: 60_000,
      compactAtTokens: 100_000,
      banner: true,
    });
  });

  it("reads saved values", () => {
    const settings = readSettings({
      claudeCodeTtl: "1h",
      codexTtl: "5m",
      piTtl: "auto",
      warnSeconds: 30,
      compactAtTokens: 50_000,
      banner: false,
    });
    expect(settings).toEqual({
      ttl: { "claude-code": "1h", codex: "5m", pi: "auto" },
      warnMs: 30_000,
      compactAtTokens: 50_000,
      banner: false,
    });
  });

  it("falls back to the default for a value of the wrong kind or out of range", () => {
    const settings = readSettings({ claudeCodeTtl: "2h", warnSeconds: -5, compactAtTokens: "lots", banner: "yes" });
    expect(settings).toEqual(readSettings(undefined));
  });
});

describe("ttlSettingFor", () => {
  it("picks the provider's lifetime setting and auto for providers without one", () => {
    const settings = readSettings({ codexTtl: "1h" });
    expect(ttlSettingFor(settings, "codex")).toBe("1h");
    expect(ttlSettingFor(settings, "claude-code")).toBe("auto");
    expect(ttlSettingFor(settings, "acp-omp")).toBe("auto");
    expect(ttlSettingFor(settings, "constructor")).toBe("auto");
  });
});
