import { diagnosticLogger as diag } from "../../logging/diagnostic.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import { cleanupCliSessionProcesses } from "./cleanup.js";

/**
 * Strip provider prefix from model ID.
 * e.g., "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5"
 */
function resolveCliModel(model?: string): string {
  if (!model) return "claude-sonnet-4-5";
  const parts = model.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : model;
}

export async function runCliAgent(params: RunEmbeddedPiAgentParams): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const cliPath = params.config?.agents?.defaults?.cli?.path ?? "claude";
  const model = resolveCliModel(params.model);
  const extraFlags = params.config?.agents?.defaults?.cli?.flags ?? [];
  const skipPermissions = params.config?.agents?.defaults?.cli?.skipPermissions ?? false;

  const args = ["-p", params.prompt];

  if (params.cliSessionId) {
    // Follow-up: resume existing session
    await cleanupCliSessionProcesses(params.cliSessionId, params.workspaceDir);
    args.push("--resume", params.cliSessionId);
  } else {
    // First run: create session with our clawdbot session ID
    args.push("--session-id", params.sessionId);
  }

  args.push("--model", model, ...extraFlags);

  if (skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  const fullCmd = [cliPath, ...args];
  diag.info(`cli exec: ${fullCmd.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
  diag.info(`cli exec: cwd=${params.workspaceDir}`);

  const result = await runCommandWithTimeout([cliPath, ...args], {
    timeoutMs: params.timeoutMs,
    cwd: params.workspaceDir,
    env: { ...process.env, NO_COLOR: "1" },
  });

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  diag.debug(`cli exit: code=${result.code} signal=${result.signal} killed=${result.killed}`);

  if (result.code !== 0) {
    const errMsg = stderr || stdout || `CLI exited with code ${result.code}`;
    diag.error(`cli error: ${errMsg.slice(0, 200)}`);
    return {
      payloads: [{ text: errMsg, isError: true }],
      meta: {
        durationMs: Date.now() - started,
        aborted: result.killed,
        agentMeta: { sessionId: params.sessionId, provider: "anthropic", model },
      },
    };
  }

  diag.debug(`cli done: textLen=${stdout.length}`);

  return {
    payloads: stdout ? [{ text: stdout }] : undefined,
    meta: {
      durationMs: Date.now() - started,
      aborted: false,
      agentMeta: { sessionId: params.sessionId, provider: "anthropic", model },
    },
  };
}
