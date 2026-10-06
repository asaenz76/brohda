import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // Phase 4.1 remediation: refuses the entire run before any test file
    // loads if the target isn't the local Supabase CLI's fixed address —
    // see tests/integration/helpers/global-setup.ts.
    globalSetup: ["tests/integration/helpers/global-setup.ts"],
    // Every test file starts in a pristine world and leaves one behind (domain rows purged, platform_settings reset to schema defaults) —
    // see tests/integration/helpers/isolation.ts. No file may depend on another having run, or on the order files run in.
    setupFiles: ["tests/integration/helpers/isolation.ts"],
    testTimeout: 20_000,
    // These tests share one real database and mutate singletons (platform_settings, the house wallet balance) — running files in
    // parallel (Vitest's default) would race them across worker threads. Files run one at a time, and the isolation setup file makes the
    // order they run in irrelevant.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/mocks/server-only.ts"),
    },
  },
});
