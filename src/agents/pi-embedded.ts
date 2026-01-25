import type { ClawdbotConfig } from "../config/config.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";
import * as embedded from "./pi-embedded-runner.js";
import * as cli from "./pi-cli-runner.js";

// Re-export types unchanged
export type {
  EmbeddedPiAgentMeta,
  EmbeddedPiCompactResult,
  EmbeddedPiRunMeta,
  EmbeddedPiRunResult,
} from "./pi-embedded-runner.js";

// Re-export utilities that don't need routing
export { compactEmbeddedPiSession, resolveEmbeddedSessionLane } from "./pi-embedded-runner.js";

/**
 * Check if CLI mode is enabled in config.
 */
function isCliMode(config?: ClawdbotConfig): boolean {
  return config?.agents?.defaults?.cli?.enabled === true;
}

/**
 * Main run function - routes to CLI or embedded runner based on config.
 */
export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  if (isCliMode(params.config)) {
    return cli.runCliAgent(params);
  }
  return embedded.runEmbeddedPiAgent(params);
}

/**
 * Queue a message to an active run. Checks both CLI and embedded run maps.
 */
export function queueEmbeddedPiMessage(sessionId: string, text: string): boolean {
  // Try embedded first (more common path)
  if (embedded.isEmbeddedPiRunActive(sessionId)) {
    return embedded.queueEmbeddedPiMessage(sessionId, text);
  }
  // Fall back to CLI runner
  if (cli.isCliRunActive(sessionId)) {
    return cli.queueCliMessage(sessionId, text);
  }
  return false;
}

/**
 * Abort an active run. Checks both CLI and embedded run maps.
 */
export function abortEmbeddedPiRun(sessionId: string): boolean {
  // Try embedded first
  if (embedded.isEmbeddedPiRunActive(sessionId)) {
    return embedded.abortEmbeddedPiRun(sessionId);
  }
  // Fall back to CLI runner
  if (cli.isCliRunActive(sessionId)) {
    return cli.abortCliRun(sessionId);
  }
  return false;
}

/**
 * Check if a run is active. Checks both CLI and embedded run maps.
 */
export function isEmbeddedPiRunActive(sessionId: string): boolean {
  return embedded.isEmbeddedPiRunActive(sessionId) || cli.isCliRunActive(sessionId);
}

/**
 * Check if a run is currently streaming. Checks both CLI and embedded run maps.
 */
export function isEmbeddedPiRunStreaming(sessionId: string): boolean {
  if (embedded.isEmbeddedPiRunActive(sessionId)) {
    return embedded.isEmbeddedPiRunStreaming(sessionId);
  }
  if (cli.isCliRunActive(sessionId)) {
    return cli.isCliRunStreaming(sessionId);
  }
  return false;
}

/**
 * Wait for a run to end. Checks both CLI and embedded run maps.
 */
export function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs?: number): Promise<boolean> {
  if (embedded.isEmbeddedPiRunActive(sessionId)) {
    return embedded.waitForEmbeddedPiRunEnd(sessionId, timeoutMs);
  }
  if (cli.isCliRunActive(sessionId)) {
    return cli.waitForCliRunEnd(sessionId, timeoutMs);
  }
  return Promise.resolve(true);
}
