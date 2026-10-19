import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { GamePreviewConfig } from "../types";
import { AnthropicGamePreviewProvider } from "./anthropic";
import type { GamePreviewProviders } from "./types";

/**
 * Selects the research / angle / writer / verifier implementations named by the stored configuration. Credentials come from the environment only (never stored, never committed, never logged). Returns null when the selected
 * provider cannot run (no credentials), which every caller reports as "not configured" rather than failing a Post or a job. A new vendor is a new case here plus its own implementation of the provider-neutral interfaces.
 */
export function createGamePreviewProviders(config: GamePreviewConfig, env: Record<string, string | undefined> = process.env): GamePreviewProviders | null {
  switch (config.provider) {
    case "anthropic": {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) return null;
      const provider = new AnthropicGamePreviewProvider(new Anthropic({ apiKey, baseURL: env.ANTHROPIC_BASE_URL || undefined }));
      return { research: provider, angles: provider, writer: provider, verifier: config.verifyWithModel ? provider : null, factVerifier: config.verifyWithModel ? provider : null };
    }
    default:
      return null;
  }
}
