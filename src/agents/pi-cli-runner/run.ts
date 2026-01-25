import { diagnosticLogger as diag } from "../../logging/diagnostic.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import { clearActiveCliRun, setActiveCliRun } from "./runs.js";
import type { CliRunHandle, CliStreamEvent } from "./types.js";

// PTY spawn function type
type IPty = {
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  kill: (signal?: string) => void;
  pid: number;
};
type PtySpawn = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    name?: string;
    cols?: number;
    rows?: number;
  },
) => IPty;

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
    "--verbose", // Required when using -p with stream-json
    ...extraFlags,
  ];

  if (skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  diag.info(`cli spawn (pty): cmd=${cliPath} sessionId=${params.sessionId} model=${model}`);

  // Load node-pty dynamically
  let spawnPty: PtySpawn;
  try {
    const ptyModule = (await import("@lydell/node-pty")) as unknown as {
      spawn?: PtySpawn;
      default?: { spawn?: PtySpawn };
    };
    const fn = ptyModule.spawn ?? ptyModule.default?.spawn;
    if (!fn) {
      throw new Error("node-pty spawn not found");
    }
    spawnPty = fn;
  } catch (err) {
    diag.error(`cli pty load failed: ${err}`);
    return {
      payloads: [{ text: `Failed to load PTY: ${err}`, isError: true }],
      meta: {
        durationMs: Date.now() - started,
        aborted: false,
        agentMeta: { sessionId: params.sessionId, provider: "anthropic", model },
      },
    };
  }

  return new Promise<EmbeddedPiRunResult>((resolve) => {
    let isStreaming = true;
    let aborted = false;
    let resolvedSessionId = params.sessionId;
    const collectedTexts: string[] = [];
    let timeoutId: NodeJS.Timeout | undefined;
    let dataBuffer = "";
    let currentTextBuffer = "";

    const pty = spawnPty(cliPath, args, {
      cwd: params.workspaceDir,
      env: { ...process.env, NO_COLOR: "1", TERM: "xterm-256color" } as Record<string, string>,
      name: "xterm-256color",
      cols: 200,
      rows: 50,
    });

    diag.info(`cli pty spawned: pid=${pty.pid} sessionId=${params.sessionId}`);

    // Store disposers for cleanup
    let dataDisposer: { dispose: () => void } | undefined;
    let exitDisposer: { dispose: () => void } | undefined;

    const handle: CliRunHandle = {
      process: { kill: (signal?: string) => pty.kill(signal) },
      abort: () => {
        if (!aborted) {
          aborted = true;
          isStreaming = false;
          pty.kill("SIGTERM");
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
      // Dispose PTY event handlers
      dataDisposer?.dispose();
      exitDisposer?.dispose();
      clearActiveCliRun(params.sessionId, handle);
      resolve(result);
    };

    // Process a single JSON line
    const processLine = (line: string) => {
      if (!line.trim()) return;

      let event: CliStreamEvent;
      try {
        event = JSON.parse(line) as CliStreamEvent;
      } catch {
        // Not JSON, might be plain text output
        diag.debug(`cli non-json line: ${line.slice(0, 100)}`);
        return;
      }

      diag.debug(`cli event: type=${event.type} sessionId=${params.sessionId}`);

      switch (event.type) {
        case "system":
          if (event.subtype === "init" && event.session_id) {
            resolvedSessionId = event.session_id;
            diag.debug(`cli session init: sessionId=${resolvedSessionId}`);
          }
          break;

        case "assistant": {
          // Format: { message: { content: [{ type: "text", text: "..." }] } }
          const content = (event.message as { content?: Array<{ type: string; text?: string }> })
            ?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                currentTextBuffer += block.text;
                params.onPartialReply?.({ text: block.text });
              }
            }
          }
          break;
        }

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
              event.content.length > 200 ? event.content.slice(0, 200) + "..." : event.content;
            params.onToolResult?.({ text: summary });
          }
          break;

        case "result": {
          if (event.session_id) {
            resolvedSessionId = event.session_id;
          }
          // Result event contains final text - but we already collected from assistant events
          // Only use result if we haven't collected anything yet (fallback)
          if (collectedTexts.length === 0 && currentTextBuffer === "") {
            const resultText = typeof event.result === "string" ? event.result : event.result?.text;
            if (resultText) {
              collectedTexts.push(resultText);
            }
          }
          break;
        }

        case "error":
          diag.error(`cli error: sessionId=${params.sessionId} msg=${event.error.message}`);
          collectedTexts.push(`Error: ${event.error.message}`);
          break;
      }
    };

    // Handle PTY data (combined stdout/stderr)
    dataDisposer = pty.onData((data) => {
      diag.debug(`cli pty data: bytes=${data.length} sessionId=${params.sessionId}`);
      dataBuffer += data;

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = dataBuffer.indexOf("\n")) !== -1) {
        const line = dataBuffer.slice(0, newlineIdx).replace(/\r$/, "");
        dataBuffer = dataBuffer.slice(newlineIdx + 1);
        processLine(line);
      }
    });

    // Handle PTY exit
    exitDisposer = pty.onExit(({ exitCode, signal }) => {
      diag.info(
        `cli pty exit: code=${exitCode} signal=${signal} sessionId=${params.sessionId} texts=${collectedTexts.length}`,
      );

      // Process any remaining data in buffer
      if (dataBuffer.trim()) {
        processLine(dataBuffer.trim());
      }

      // Flush any remaining text
      if (currentTextBuffer) {
        collectedTexts.push(currentTextBuffer);
      }

      const payloads =
        collectedTexts.length > 0 ? collectedTexts.map((text) => ({ text })) : undefined;

      if (exitCode !== 0 && !aborted && collectedTexts.length === 0) {
        finalize({
          payloads: [{ text: `CLI exited with code ${exitCode}`, isError: true }],
          meta: {
            durationMs: Date.now() - started,
            aborted,
            agentMeta: { sessionId: resolvedSessionId, provider: "anthropic", model },
          },
        });
        return;
      }

      finalize({
        payloads,
        meta: {
          durationMs: Date.now() - started,
          aborted,
          agentMeta: { sessionId: resolvedSessionId, provider: "anthropic", model },
        },
      });
    });
  });
}
