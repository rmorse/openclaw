import chalk from "chalk";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { loadConfig } from "../config/config.js";
import { getResolvedLoggerSettings } from "../logging.js";

export function logGatewayStartup(params: {
  cfg: ReturnType<typeof loadConfig>;
  bindHost: string;
  port: number;
  tlsEnabled?: boolean;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
}) {
  const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const modelRef = `${agentProvider}/${agentModel}`;
  params.log.info(`agent model: ${modelRef}`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)}`,
  });
  const cliEnabled = params.cfg?.agents?.defaults?.cli?.enabled === true;
  if (cliEnabled) {
    const cliPath = params.cfg?.agents?.defaults?.cli?.path ?? "claude";
    params.log.info(`cli runner: enabled (${cliPath})`, {
      consoleMessage: `cli runner: ${chalk.greenBright("enabled")} (${cliPath})`,
    });
  }
  const scheme = params.tlsEnabled ? "wss" : "ws";
  params.log.info(
    `listening on ${scheme}://${params.bindHost}:${params.port} (PID ${process.pid})`,
  );
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }
}
