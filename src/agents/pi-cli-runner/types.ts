import type { ChildProcess } from "node:child_process";

export type CliRunHandle = {
  process: ChildProcess;
  abort: () => void;
  isStreaming: () => boolean;
  queueMessage: (text: string) => Promise<void>;
};

/**
 * Stream-JSON events from `claude --output-format stream-json`.
 * Types based on observed CLI output format.
 */
export type CliStreamEvent =
  | { type: "system"; subtype: "init"; session_id?: string }
  | { type: "assistant"; message: { type: "text"; text: string } }
  | { type: "content_block_start"; content_block: { type: "text"; text?: string } }
  | { type: "content_block_delta"; delta: { type: "text_delta"; text: string } }
  | { type: "content_block_stop" }
  | { type: "tool_use"; tool: { name: string; input: unknown } }
  | { type: "tool_result"; content?: string }
  | { type: "result"; result?: { text?: string }; session_id?: string; cost_usd?: number }
  | { type: "error"; error: { message: string } };
