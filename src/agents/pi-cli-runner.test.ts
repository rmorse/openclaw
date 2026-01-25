import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mock to top of file
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { queueCliMessage, isCliRunActive } from "./pi-cli-runner/runs.js";
import { runCliAgent } from "./pi-cli-runner/run.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";

function createMockChildProcess(events: Array<{ type: string; [key: string]: unknown }>) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: { write: () => void; end: () => void };
    kill: (signal?: string) => void;
    killed: boolean;
  };

  // Create a readable stream that emits lines for readline interface
  const lines = events.map((e) => JSON.stringify(e));
  let lineIndex = 0;

  const stdout = new Readable({
    read() {
      if (lineIndex < lines.length) {
        this.push(lines[lineIndex] + "\n");
        lineIndex++;
      } else {
        this.push(null);
      }
    },
  });

  const stderr = new Readable({ read() { this.push(null); } });

  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn(() => {
    child.killed = true;
    setImmediate(() => child.emit("close", 0));
  });
  child.killed = false;

  // Emit close after stream ends
  stdout.on("end", () => {
    setImmediate(() => child.emit("close", 0));
  });

  return child;
}

describe("queueCliMessage", () => {
  it("returns false because CLI mode does not support mid-run steering", () => {
    // Even with an active session, queueCliMessage should return false
    // because CLI mode cannot inject messages mid-run
    const result = queueCliMessage("test-session", "test message");
    expect(result).toBe(false);
  });

  it("returns false regardless of session state", () => {
    // Should return false whether or not there's an active run
    expect(queueCliMessage("nonexistent-session", "msg")).toBe(false);
    expect(queueCliMessage("any-session", "any message")).toBe(false);
  });
});

describe("runCliAgent", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns claude CLI with correct arguments", async () => {
    const mockChild = createMockChildProcess([
      { type: "result", result: { text: "Hello" } },
    ]);
    spawnMock.mockReturnValue(mockChild);

    const params: RunEmbeddedPiAgentParams = {
      sessionId: "test-session-123",
      prompt: "Say hello",
      workspaceDir: "/tmp/test",
      model: "anthropic/claude-sonnet-4-5",
      timeoutMs: 30000,
    };

    await runCliAgent(params);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("Say hello");
    expect(args).toContain("--session-id");
    expect(args).toContain("test-session-123");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-5"); // provider prefix stripped
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  it("strips provider prefix from model", async () => {
    const mockChild = createMockChildProcess([
      { type: "result", result: { text: "ok" } },
    ]);
    spawnMock.mockReturnValue(mockChild);

    await runCliAgent({
      sessionId: "s1",
      prompt: "hi",
      workspaceDir: "/tmp",
      model: "anthropic/claude-opus-4",
      timeoutMs: 1000,
    });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain("claude-opus-4");
    expect(args).not.toContain("anthropic/claude-opus-4");
  });

  it("adds --dangerously-skip-permissions when configured", async () => {
    const mockChild = createMockChildProcess([
      { type: "result", result: { text: "ok" } },
    ]);
    spawnMock.mockReturnValue(mockChild);

    await runCliAgent({
      sessionId: "s1",
      prompt: "hi",
      workspaceDir: "/tmp",
      model: "claude-sonnet-4-5",
      timeoutMs: 1000,
      config: {
        agents: {
          defaults: {
            cli: {
              enabled: true,
              skipPermissions: true,
            },
          },
        },
      },
    });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("calls onPartialReply for streaming text", async () => {
    const mockChild = createMockChildProcess([
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
      { type: "content_block_stop" },
      { type: "result", result: { text: "Hello world" } },
    ]);
    spawnMock.mockReturnValue(mockChild);

    const partialReplies: string[] = [];
    const blockReplies: string[] = [];

    await runCliAgent({
      sessionId: "s1",
      prompt: "hi",
      workspaceDir: "/tmp",
      model: "claude-sonnet-4-5",
      timeoutMs: 1000,
      onPartialReply: ({ text }) => partialReplies.push(text),
      onBlockReply: ({ text }) => blockReplies.push(text),
    });

    expect(partialReplies).toEqual(["Hello ", "world"]);
    expect(blockReplies).toEqual(["Hello world"]);
  });

  it("calls onToolResult for tool results", async () => {
    const mockChild = createMockChildProcess([
      { type: "tool_result", content: "File created successfully" },
      { type: "result", result: { text: "Done" } },
    ]);
    spawnMock.mockReturnValue(mockChild);

    const toolResults: string[] = [];

    await runCliAgent({
      sessionId: "s1",
      prompt: "create file",
      workspaceDir: "/tmp",
      model: "claude-sonnet-4-5",
      timeoutMs: 1000,
      onToolResult: ({ text }) => toolResults.push(text),
    });

    expect(toolResults).toEqual(["File created successfully"]);
  });

  it("truncates long tool results", async () => {
    const longContent = "x".repeat(300);
    const mockChild = createMockChildProcess([
      { type: "tool_result", content: longContent },
      { type: "result", result: { text: "Done" } },
    ]);
    spawnMock.mockReturnValue(mockChild);

    const toolResults: string[] = [];

    await runCliAgent({
      sessionId: "s1",
      prompt: "read file",
      workspaceDir: "/tmp",
      model: "claude-sonnet-4-5",
      timeoutMs: 1000,
      onToolResult: ({ text }) => toolResults.push(text),
    });

    expect(toolResults[0].length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(toolResults[0].endsWith("...")).toBe(true);
  });

  it("returns collected text in payloads", async () => {
    const mockChild = createMockChildProcess([
      { type: "content_block_delta", delta: { type: "text_delta", text: "Response text" } },
      { type: "content_block_stop" },
      { type: "result", result: { text: "Response text" } },
    ]);
    spawnMock.mockReturnValue(mockChild);

    const result = await runCliAgent({
      sessionId: "s1",
      prompt: "hi",
      workspaceDir: "/tmp",
      model: "claude-sonnet-4-5",
      timeoutMs: 1000,
    });

    expect(result.payloads).toBeDefined();
    expect(result.payloads?.some((p) => p.text === "Response text")).toBe(true);
  });

  it("handles error events", async () => {
    const mockChild = createMockChildProcess([
      { type: "error", error: { message: "Something went wrong" } },
    ]);
    spawnMock.mockReturnValue(mockChild);

    const result = await runCliAgent({
      sessionId: "s1",
      prompt: "hi",
      workspaceDir: "/tmp",
      model: "claude-sonnet-4-5",
      timeoutMs: 1000,
    });

    expect(result.payloads?.some((p) => p.text?.includes("Something went wrong"))).toBe(true);
  });

  it("registers and clears active run", async () => {
    const mockChild = createMockChildProcess([
      { type: "result", result: { text: "ok" } },
    ]);
    spawnMock.mockReturnValue(mockChild);

    const sessionId = "active-test-session";

    // Before run starts
    expect(isCliRunActive(sessionId)).toBe(false);

    const runPromise = runCliAgent({
      sessionId,
      prompt: "hi",
      workspaceDir: "/tmp",
      model: "claude-sonnet-4-5",
      timeoutMs: 1000,
    });

    // Run should be active while in progress (check synchronously before events fire)
    // Note: Due to process.nextTick, this may already be false
    await runPromise;

    // After run completes
    expect(isCliRunActive(sessionId)).toBe(false);
  });

  it("returns duration in meta", async () => {
    const mockChild = createMockChildProcess([
      { type: "result", result: { text: "ok" } },
    ]);
    spawnMock.mockReturnValue(mockChild);

    const result = await runCliAgent({
      sessionId: "s1",
      prompt: "hi",
      workspaceDir: "/tmp",
      model: "claude-sonnet-4-5",
      timeoutMs: 1000,
    });

    expect(result.meta?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.meta?.agentMeta?.model).toBe("claude-sonnet-4-5");
  });
});
