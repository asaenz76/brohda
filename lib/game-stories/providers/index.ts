import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { PipelineDeps } from "../pipeline";
import type { StoryConfig } from "../types";
import { AnthropicStoryProvider, StoryProviderError } from "./anthropic";

/**
 * Builds the injected dependencies of the pipeline from the stored configuration and the server environment. The API key is read here and nowhere else; with no key (or a provider this build does not know)
 * the run fails cleanly with `credentials_missing` — there is no fallback provider and no silent downgrade.
 */
export function createPipelineDeps(config: StoryConfig, env: Record<string, string | undefined> = process.env): PipelineDeps {
  if (config.provider !== "anthropic") throw new StoryProviderError("provider_error", `provider_unknown: ${config.provider}`);
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new StoryProviderError("credentials_missing", "ANTHROPIC_API_KEY is not configured for this environment");
  const client = new Anthropic({ apiKey, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 0 });
  const provider = new AnthropicStoryProvider(client, { model: config.model, effort: config.effort, retries: config.providerRetries, timeoutMs: config.requestTimeoutSeconds * 1000, webSearchToolVersion: config.webSearchToolVersion });
  return { research: provider, angles: provider, drafter: provider, verifier: provider, scorer: provider, newId: () => crypto.randomUUID(), now: () => new Date() };
}

export const credentialsConfigured = (env: Record<string, string | undefined> = process.env): boolean => Boolean(env.ANTHROPIC_API_KEY);
