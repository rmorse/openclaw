import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Kill any stale Claude CLI processes holding a session ID.
 * This prevents "Session ID xxx is already in use" errors when resuming sessions.
 */
export async function cleanupCliSessionProcesses(sessionId: string, cwd?: string): Promise<void> {
  try {
    // Find and kill processes with this session ID in their args
    // Use pkill with pattern matching for --session-id <id>
    await execAsync(`pkill -9 -f "claude.*--session-id.*${sessionId}" || true`, {
      cwd,
      timeout: 5000,
    });
  } catch {
    // Ignore errors - process might not exist
  }
}
