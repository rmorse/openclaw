import fs from "node:fs";
import path from "node:path";
import { resolveAgentDir } from "./agent-scope.js";
import type { ClawdbotConfig } from "../config/config.js";

function getMapPath(cfg: ClawdbotConfig, agentId?: string): string {
  const agentDir = resolveAgentDir(cfg, agentId ?? "main");
  return path.join(agentDir, "cli-session-map.json");
}

export function saveCliSessionMapping(
  cfg: ClawdbotConfig,
  clawdbotSessionId: string,
  claudeCliSessionId: string,
  agentId?: string,
): void {
  const mapPath = getMapPath(cfg, agentId);
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
  } catch {
    // ignore
  }
  map[clawdbotSessionId] = claudeCliSessionId;
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));
}

export function getCliSessionMapping(
  cfg: ClawdbotConfig,
  clawdbotSessionId: string,
  agentId?: string,
): string | undefined {
  const mapPath = getMapPath(cfg, agentId);
  try {
    const map = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
    return map[clawdbotSessionId];
  } catch {
    return undefined;
  }
}
