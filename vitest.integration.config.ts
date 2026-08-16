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
    testTimeout: 20_000,
    // These tests share one real database and some rely on another file's
    // setup already having run (e.g. an admin account looked up but never
    // created locally) or mutate a singleton (the house wallet balance) —
    // running files in parallel (Vitest's default) races both of those
    // across worker threads, non-deterministically, depending on how many
    // cores/threads happen to be available on whatever machine runs this.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "tests/mocks/server-only.ts"),
    },
  },
});
