import "server-only";
import type { GamePreviewConfig } from "../types";
import { OpenAIGamePreviewProvider } from "./openai";
import type { GamePreviewProviders } from "./types";

/**
 * Selects the research / writer / verifier implementations named by the stored configuration. Credentials come from the environment only (never stored, never committed). Returns null when the selected provider cannot run
 * (no credentials), which every caller reports as "not configured" rather than failing a Post or a job.
 */
export function createGamePreviewProviders(config: GamePreviewConfig, env: Record<string, string | undefined> = process.env): GamePreviewProviders | null {
  switch (config.provider) {
    case "openai": {
      const apiKey = env.OPENAI_API_KEY;
      if (!apiKey) return null;
      const provider = new OpenAIGamePreviewProvider({ apiKey, baseUrl: env.OPENAI_BASE_URL });
      return { research: provider, writer: provider, verifier: config.verifyWithModel ? provider : null };
    }
    default:
      return null;
  }
}
