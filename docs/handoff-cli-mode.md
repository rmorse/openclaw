# Handoff: CLI Mode for Agent Runs

## Original Task Instruction

```
# Plan: CLI Mode for Agent Runs

Route conversations through `claude` CLI instead of embedded Pi SDK when `agent.cli.enabled: true`.

## Design: Smart Router Pattern

Transform `pi-embedded.ts` from dumb re-export → smart router. **Zero changes to consumers.**

```
agent-runner.ts (unchanged)
       ↓
pi-embedded.ts (router) ──→ config.agent.cli.enabled?
       ↓                          ↓
pi-embedded-runner/         pi-cli-runner/ (NEW)
(existing SDK)              (spawns `claude` CLI)
```

**Note**: After recent refactor, embedded runner is now in `pi-embedded-runner/` subdirectory:
- `pi-embedded-runner/run.ts` - main run function
- `pi-embedded-runner/runs.ts` - active run tracking (queue, abort, etc)
- `pi-embedded-runner/types.ts` - type definitions

## Files to Modify

| File | Change |
|------|--------|
| `src/config/types.ts` | Add `CliRunnerConfig` type (~10 lines) |
| `src/config/zod-schema.ts` | Add Zod validation (~10 lines) |
| `src/agents/pi-cli-runner/` | **NEW directory** - CLI runner implementation |
| `src/agents/pi-cli-runner/run.ts` | **NEW** - main `runCliAgent` function (~200 lines) |
| `src/agents/pi-cli-runner/runs.ts` | **NEW** - active run tracking (~80 lines) |
| `src/agents/pi-cli-runner/types.ts` | **NEW** - shared types (~20 lines) |
| `src/agents/pi-embedded.ts` | Transform to smart router (~60 lines) |

**Total: 1 new directory (3 files) + 3 small edits. Zero consumer changes.**

This mirrors the existing `pi-embedded-runner/` structure for consistency.

## 1. Config Schema

**`src/config/types.ts`** - Add inside `ClawdbotConfig.agent`:

```typescript
cli?: {
  /** Enable CLI mode. Default: false */
  enabled?: boolean;
  /** Path to claude binary. Default: 'claude' */
  path?: string;
  /** Extra CLI flags */
  flags?: string[];
  /** Skip permission prompts. Default: false */
  skipPermissions?: boolean;
};
```

**`src/config/zod-schema.ts`** - Add to agent schema:

```typescript
cli: z.object({
  enabled: z.boolean().optional(),
  path: z.string().optional(),
  flags: z.array(z.string()).optional(),
  skipPermissions: z.boolean().optional(),
}).optional(),
```

## 2. New CLI Runner

**`src/agents/pi-cli-runner.ts`**

Core implementation:

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";

const ACTIVE_CLI_RUNS = new Map<string, CliRunHandle>();

type CliRunHandle = {
  process: ChildProcess;
  abort: () => void;
  isStreaming: () => boolean;
};

export async function runCliAgent(params: RunCliAgentParams): Promise<EmbeddedPiRunResult> {
  const cliPath = params.config?.agent?.cli?.path ?? "claude";
  const model = resolveCliModel(params.model); // strip provider prefix

  const args = [
    "-p", params.prompt,
    "--session-id", params.sessionId,
    "--model", model,
    "--output-format", "stream-json",
  ];

  if (params.config?.agent?.cli?.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  const child = spawn(cliPath, args, { cwd: params.workspaceDir });

  // Track active run
  ACTIVE_CLI_RUNS.set(params.sessionId, { process: child, ... });

  // Stream stdout line-by-line, parse JSON events
  // Call onPartialReply/onBlockReply/onToolResult callbacks
  // Handle timeout with process.kill()

  // Return EmbeddedPiRunResult
}

// Helper functions matching embedded runner interface:
export function queueCliMessage(sessionId: string, text: string): boolean;
export function abortCliRun(sessionId: string): boolean;
export function isCliRunActive(sessionId: string): boolean;
export function isCliRunStreaming(sessionId: string): boolean;
export function waitForCliRunEnd(sessionId: string, timeoutMs?: number): Promise<boolean>;
```

**CLI Command**:
```bash
claude -p "<prompt>" \
  --session-id "<uuid>" \
  --model "claude-sonnet-4-5" \
  --output-format stream-json
```

**Model transformation**: `anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`

## 3. Smart Router

**`src/agents/pi-embedded.ts`** - Transform to router:

```typescript
import * as embedded from "./pi-embedded-runner.js";
import * as cli from "./pi-cli-runner.js";

// Re-export types unchanged
export type { EmbeddedPiRunResult, ... } from "./pi-embedded-runner.js";

function isCliMode(config?: ClawdbotConfig): boolean {
  return config?.agent?.cli?.enabled === true;
}

// Main run function - routes based on config
export async function runEmbeddedPiAgent(params) {
  if (isCliMode(params.config)) {
    return cli.runCliAgent(params);
  }
  return embedded.runEmbeddedPiAgent(params);
}

// Helper functions - check both maps
export function queueEmbeddedPiMessage(sessionId: string, text: string): boolean {
  if (embedded.isEmbeddedPiRunActive(sessionId)) {
    return embedded.queueEmbeddedPiMessage(sessionId, text);
  }
  return cli.queueCliMessage(sessionId, text);
}

export function abortEmbeddedPiRun(sessionId: string): boolean {
  if (embedded.isEmbeddedPiRunActive(sessionId)) {
    return embedded.abortEmbeddedPiRun(sessionId);
  }
  return cli.abortCliRun(sessionId);
}

// ... same pattern for isEmbeddedPiRunActive, isEmbeddedPiRunStreaming, etc.
```

## 4. Stream-JSON Parsing

Claude CLI `--output-format stream-json` emits newline-delimited JSON:

```typescript
type StreamEvent =
  | { type: "assistant"; message: { type: "text"; text: string } }
  | { type: "tool_use"; tool: { name: string; input: unknown } }
  | { type: "tool_result"; result: unknown }
  | { type: "result"; result: { text?: string } }
  | { type: "error"; error: { message: string } };
```

Map to callbacks:
- `type: "assistant"` + `message.type: "text"` → `onPartialReply({ text })`
- `type: "tool_result"` → `onToolResult({ text: summary })`
- `type: "result"` → final payload for `EmbeddedPiRunResult.payloads`

## 5. Example Config

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    cli: {
      enabled: true,
      skipPermissions: true
    }
  }
}
```

## Verification

1. **Unit test**: Mock `child_process.spawn`, verify stream parsing
2. **Integration test**: Enable CLI mode, send message, verify response
3. **Streaming test**: Verify `onPartialReply` fires during CLI output
4. **Abort test**: Send message, abort mid-stream, verify cleanup
5. **Session continuity**: Send multiple messages, verify `--session-id` preserves context

## Implementation Order

1. Add config types + zod schema
2. Create `pi-cli-runner.ts` with core spawn/parse logic
3. Transform `pi-embedded.ts` to smart router
4. Test manually with `agent.cli.enabled: true`
```

---

## Completed Work

### 1. Config Schema - DONE

**`src/config/types.agent-defaults.ts`**
- Added `CliRunnerConfig` type with fields: `enabled`, `path`, `flags`, `skipPermissions`
- Added `cli?: CliRunnerConfig` field to `AgentDefaultsConfig`

**`src/config/zod-schema.agent-defaults.ts`**
- Added `CliRunnerSchema` Zod validator
- Added `cli: CliRunnerSchema` to `AgentDefaultsSchema`

### 2. New CLI Runner Directory - DONE

Created `src/agents/pi-cli-runner/` with 3 files:

**`src/agents/pi-cli-runner/types.ts`**
- `CliRunHandle` type (process, abort, isStreaming, queueMessage)
- `CliStreamEvent` union type for stream-json parsing

**`src/agents/pi-cli-runner/runs.ts`**
- `ACTIVE_CLI_RUNS` Map + waiter system (mirrors embedded runner)
- Exports: `queueCliMessage`, `abortCliRun`, `isCliRunActive`, `isCliRunStreaming`, `waitForCliRunEnd`, `setActiveCliRun`, `clearActiveCliRun`

**`src/agents/pi-cli-runner/run.ts`**
- `runCliAgent(params)` - spawns `claude` CLI with `--output-format stream-json`
- Parses NDJSON stream, calls `onPartialReply`, `onBlockReply`, `onToolResult` callbacks
- Handles timeout, abort, error cases
- Returns `EmbeddedPiRunResult` matching embedded runner interface

### 3. Barrel Export - DONE

**`src/agents/pi-cli-runner.ts`**
- Re-exports all public functions/types from the directory

### 4. Smart Router - DONE

**`src/agents/pi-embedded.ts`** - Transformed from dumb re-export to smart router:
- `isCliMode(config)` helper checks `agents.defaults.cli.enabled`
- `runEmbeddedPiAgent()` routes to CLI or embedded based on config
- `queueEmbeddedPiMessage()`, `abortEmbeddedPiRun()`, `isEmbeddedPiRunActive()`, `isEmbeddedPiRunStreaming()`, `waitForEmbeddedPiRunEnd()` - all check both CLI and embedded run maps

### 5. Verification Done
- TypeScript compiles clean (`npx tsc --noEmit` - no errors)
- ESLint passes on all new/modified files

---

## Remaining Work

### 1. Run Full Test Suite
```bash
npm test
```
Tests were not run to completion.

### 2. Manual Integration Test
Enable CLI mode in config and verify end-to-end:
```json5
{
  agents: {
    defaults: {
      cli: {
        enabled: true,
        skipPermissions: true
      }
    }
  }
}
```
Then send a message and verify:
- CLI spawns correctly
- Streaming works (`onPartialReply` fires)
- Session ID is preserved across messages
- Abort works mid-stream

### 3. Edge Cases to Verify
- **Session continuity**: Multiple messages to same session use `--session-id`
- **Model transformation**: `anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`
- **Timeout handling**: Config timeout triggers process kill
- **Error handling**: CLI exit codes, stderr capture

### 4. Optional: Unit Tests
Create `src/agents/pi-cli-runner/run.test.ts` with mocked `child_process.spawn` to test:
- Stream parsing for each event type
- Callback invocation order
- Abort/timeout behavior

---

## Files Changed Summary

| File | Status |
|------|--------|
| `src/config/types.agent-defaults.ts` | Modified (+12 lines) |
| `src/config/zod-schema.agent-defaults.ts` | Modified (+9 lines) |
| `src/agents/pi-cli-runner/types.ts` | **NEW** (~25 lines) |
| `src/agents/pi-cli-runner/runs.ts` | **NEW** (~100 lines) |
| `src/agents/pi-cli-runner/run.ts` | **NEW** (~180 lines) |
| `src/agents/pi-cli-runner.ts` | **NEW** (~10 lines) |
| `src/agents/pi-embedded.ts` | Replaced (~100 lines) |

---

## Config Path Note

The original plan mentioned `config.agent.cli.enabled` but the actual codebase uses `config.agents.defaults`. The implementation correctly uses:

```typescript
config?.agents?.defaults?.cli?.enabled === true
```

This matches the existing config structure where agent defaults live under `agents.defaults`.
