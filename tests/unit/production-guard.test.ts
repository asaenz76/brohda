import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProductionWriteConfirmed, resolveSupabaseTarget } from "../../scripts/lib/production-guard";

describe("resolveSupabaseTarget", () => {
  it("recognizes every local Supabase form as local", () => {
    expect(resolveSupabaseTarget("http://127.0.0.1:54321")).toBe("local");
    expect(resolveSupabaseTarget("http://localhost:54321")).toBe("local");
    expect(resolveSupabaseTarget("https://localhost")).toBe("local");
  });

  it("treats any real hosted URL as remote — production or otherwise", () => {
    expect(resolveSupabaseTarget("https://wovfovohynwxgfwdztti.supabase.co")).toBe("remote");
    expect(resolveSupabaseTarget("https://some-other-project.supabase.co")).toBe("remote");
  });
});

describe("assertProductionWriteConfirmed", () => {
  const originalArgv = process.argv;
  const originalEnv = process.env.CONFIRM_PRODUCTION_WRITE;

  afterEach(() => {
    process.argv = originalArgv;
    process.env.CONFIRM_PRODUCTION_WRITE = originalEnv;
    vi.restoreAllMocks();
  });

  it("does nothing for a local target — never blocks normal local dev", () => {
    process.argv = ["node", "script.ts"];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    assertProductionWriteConfirmed("http://127.0.0.1:54321", "test-script");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("refuses a remote target with no confirmation — this is the exact incident it exists to prevent", () => {
    process.argv = ["node", "script.ts"];
    delete process.env.CONFIRM_PRODUCTION_WRITE;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    assertProductionWriteConfirmed("https://real-project.supabase.co", "test-script");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Refusing to run"));
  });

  it("proceeds for a remote target when --production is explicitly passed", () => {
    process.argv = ["node", "script.ts", "--production"];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    assertProductionWriteConfirmed("https://real-project.supabase.co", "test-script");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("proceeds for a remote target when CONFIRM_PRODUCTION_WRITE=1 is set — non-interactive override", () => {
    process.argv = ["node", "script.ts"];
    process.env.CONFIRM_PRODUCTION_WRITE = "1";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    assertProductionWriteConfirmed("https://real-project.supabase.co", "test-script");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
