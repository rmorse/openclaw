import {
  diagnosticLogger as diag,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import type { CliRunHandle } from "./types.js";

const ACTIVE_CLI_RUNS = new Map<string, CliRunHandle>();

type CliRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};
const CLI_RUN_WAITERS = new Map<string, Set<CliRunWaiter>>();

export function queueCliMessage(sessionId: string, text: string): boolean {
  // CLI mode doesn't support mid-run steering; callers should use followup runs
  diag.debug(`cli queue unsupported: sessionId=${sessionId} textLen=${text.length}`);
  return false;
}

export function abortCliRun(sessionId: string): boolean {
  const handle = ACTIVE_CLI_RUNS.get(sessionId);
  if (!handle) {
    diag.debug(`cli abort failed: sessionId=${sessionId} reason=no_active_run`);
    return false;
  }
  diag.debug(`cli aborting: sessionId=${sessionId}`);
  handle.abort();
  return true;
}

export function isCliRunActive(sessionId: string): boolean {
  const active = ACTIVE_CLI_RUNS.has(sessionId);
  if (active) {
    diag.debug(`cli run active: sessionId=${sessionId}`);
  }
  return active;
}

export function isCliRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_CLI_RUNS.get(sessionId);
  return handle?.isStreaming() ?? false;
}

export function waitForCliRunEnd(sessionId: string, timeoutMs = 15_000): Promise<boolean> {
  if (!sessionId || !ACTIVE_CLI_RUNS.has(sessionId)) return Promise.resolve(true);
  diag.debug(`cli wait: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
  return new Promise((resolve) => {
    const waiters = CLI_RUN_WAITERS.get(sessionId) ?? new Set();
    const waiter: CliRunWaiter = {
      resolve,
      timer: setTimeout(
        () => {
          waiters.delete(waiter);
          if (waiters.size === 0) CLI_RUN_WAITERS.delete(sessionId);
          diag.warn(`cli wait timeout: sessionId=${sessionId}`);
          resolve(false);
        },
        Math.max(100, timeoutMs),
      ),
    };
    waiters.add(waiter);
    CLI_RUN_WAITERS.set(sessionId, waiters);
    if (!ACTIVE_CLI_RUNS.has(sessionId)) {
      waiters.delete(waiter);
      if (waiters.size === 0) CLI_RUN_WAITERS.delete(sessionId);
      clearTimeout(waiter.timer);
      resolve(true);
    }
  });
}

function notifyCliRunEnded(sessionId: string) {
  const waiters = CLI_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) return;
  CLI_RUN_WAITERS.delete(sessionId);
  diag.debug(`cli notifying waiters: sessionId=${sessionId} count=${waiters.size}`);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

export function setActiveCliRun(sessionId: string, handle: CliRunHandle) {
  const wasActive = ACTIVE_CLI_RUNS.has(sessionId);
  ACTIVE_CLI_RUNS.set(sessionId, handle);
  logSessionStateChange({
    sessionId,
    state: "processing",
    reason: wasActive ? "cli_run_replaced" : "cli_run_started",
  });
  if (!sessionId.startsWith("probe-")) {
    diag.debug(`cli run registered: sessionId=${sessionId} total=${ACTIVE_CLI_RUNS.size}`);
  }
}

export function clearActiveCliRun(sessionId: string, handle: CliRunHandle) {
  if (ACTIVE_CLI_RUNS.get(sessionId) === handle) {
    ACTIVE_CLI_RUNS.delete(sessionId);
    logSessionStateChange({ sessionId, state: "idle", reason: "cli_run_completed" });
    if (!sessionId.startsWith("probe-")) {
      diag.debug(`cli run cleared: sessionId=${sessionId} total=${ACTIVE_CLI_RUNS.size}`);
    }
    notifyCliRunEnded(sessionId);
  } else {
    diag.debug(`cli clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
  }
}
