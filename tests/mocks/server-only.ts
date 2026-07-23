// Vitest runs in plain Node, not Next's `react-server` bundler condition,
// so the real `server-only` package (which throws unconditionally outside
// that condition) is aliased to this no-op for tests.
export {};
