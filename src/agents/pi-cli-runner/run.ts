import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { diagnosticLogger as diag } from "../../logging/diagnostic.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import { clearActiveCliRun, setActiveCliRun } from "./runs.js";
import type { CliRunHandle, CliStreamEvent } from "./types.js";

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

  const args = [
    "-p",
    params.prompt,
    "--session-id",
    params.sessionId,
    "--model",
    model,
    "--output-format",
    "stream-json",
    ...extraFlags,
  ];

  if (skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  diag.info(`cli spawn: cmd=${cliPath} sessionId=${params.sessionId} model=${model}`);

  return new Promise<EmbeddedPiRunResult>((resolve) => {
    let isStreaming = true;
    let aborted = false;
    let resolvedSessionId = params.sessionId;
    const collectedTexts: string[] = [];
    let timeoutId: NodeJS.Timeout | undefined;

    const child = spawn(cliPath, args, {
      cwd: params.workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });

    const handle: CliRunHandle = {
      process: child,
      abort: () => {
        if (!aborted) {
          aborted = true;
          isStreaming = false;
          child.kill("SIGTERM");
          diag.debug(`cli aborted: sessionId=${params.sessionId}`);
        }
      },
      isStreaming: () => isStreaming,
      queueMessage: async () => {
        // No-op: CLI mode doesn't support mid-run steering
      },
    };

    setActiveCliRun(params.sessionId, handle);

    if (params.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (isStreaming) {
          diag.warn(`cli timeout: sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`);
          handle.abort();
        }
      }, params.timeoutMs);
    }

    const finalize = (result: EmbeddedPiRunResult) => {
      if (timeoutId) clearTimeout(timeoutId);
      isStreaming = false;
      clearActiveCliRun(params.sessionId, handle);
      resolve(result);
    };

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let currentTextBuffer = "";

    rl.on("line", (line) => {
      if (!line.trim()) return;

      let event: CliStreamEvent;
      try {
        event = JSON.parse(line) as CliStreamEvent;
      } catch {
        diag.debug(`cli parse error: line=${line.slice(0, 100)}`);
        return;
      }

      switch (event.type) {
        case "system":
          if (event.subtype === "init" && event.session_id) {
            resolvedSessionId = event.session_id;
            diag.debug(`cli session init: sessionId=${resolvedSessionId}`);
          }
          break;

        case "assistant":
          if (event.message?.type === "text" && event.message.text) {
            currentTextBuffer += event.message.text;
            params.onPartialReply?.({ text: event.message.text });
          }
          break;

        case "content_block_delta":
          if (event.delta?.type === "text_delta" && event.delta.text) {
            currentTextBuffer += event.delta.text;
            params.onPartialReply?.({ text: event.delta.text });
          }
          break;

        case "content_block_stop":
          if (currentTextBuffer) {
            collectedTexts.push(currentTextBuffer);
            params.onBlockReply?.({ text: currentTextBuffer });
            currentTextBuffer = "";
          }
          break;

        case "tool_result":
          if (event.content) {
            const summary =
              event.content.length > 200
                ? event.content.slice(0, 200) + "..."
                : event.content;
            params.onToolResult?.({ text: summary });
          }
          break;

        case "result":
          if (event.session_id) {
            resolvedSessionId = event.session_id;
          }
          if (event.result?.text && !collectedTexts.includes(event.result.text)) {
            collectedTexts.push(event.result.text);
          }
          break;

        case "error":
          diag.error(`cli error: sessionId=${params.sessionId} msg=${event.error.message}`);
          collectedTexts.push(`Error: ${event.error.message}`);
          break;
      }
    });

    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.on("close", (code) => {
      diag.debug(`cli closed: sessionId=${params.sessionId} code=${code} aborted=${aborted}`);

      // Flush any remaining text
      if (currentTextBuffer) {
        collectedTexts.push(currentTextBuffer);
      }

      const payloads = collectedTexts.length > 0
        ? collectedTexts.map((text) => ({ text }))
        : undefined;

      // Check for errors in stderr
      if (code !== 0 && stderrBuffer && !aborted) {
        const errorPayload = {
          text: `CLI error (exit ${code}): ${stderrBuffer.trim().slice(0, 500)}`,
          isError: true,
        };
        finalize({
          payloads: payloads ? [...payloads, errorPayload] : [errorPayload],
          meta: {
            durationMs: Date.now() - started,
            aborted,
            agentMeta: {
              sessionId: resolvedSessionId,
              provider: "anthropic",
              model,
            },
          },
        });
        return;
      }

      finalize({
        payloads,
        meta: {
          durationMs: Date.now() - started,
          aborted,
          agentMeta: {
            sessionId: resolvedSessionId,
            provider: "anthropic",
            model,
          },
        },
      });
    });

    child.on("error", (err) => {
      diag.error(`cli spawn error: sessionId=${params.sessionId} err=${err.message}`);
      finalize({
        payloads: [{ text: `Failed to spawn CLI: ${err.message}`, isError: true }],
        meta: {
          durationMs: Date.now() - started,
          aborted,
          agentMeta: {
            sessionId: resolvedSessionId,
            provider: "anthropic",
            model,
          },
        },
      });
    });
  });
}
