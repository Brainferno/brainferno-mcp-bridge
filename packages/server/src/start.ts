import { pidAlive, readHandshake } from "./bridge/handshake.js";
import type { Config } from "./config.js";
import { startHttpServer, type RunningHttpServer } from "./http.js";
import { buildRuntime, createMcpServer, type Runtime } from "./server.js";

export interface StartedRuntime {
  rt: Runtime;
  /** The shared-mode listener, or null when shared mode is off (`httpPort` 0). */
  remote: RunningHttpServer | null;
}

/**
 * What to say when the shared-mode port is taken. A live handshake file names the most
 * likely holder: another server of ours, such as a second Claude Code window on this machine.
 */
export function sharedPortInUseMessage(config: Pick<Config, "httpHost" | "httpPort" | "handshakeFilePath">): string {
  const other = config.handshakeFilePath === "" ? null : readHandshake(config.handshakeFilePath);
  const holder =
    other !== null && pidAlive(other.pid)
      ? `another brainferno-mcp-bridge server is running (pid ${other.pid}) and probably holds it`
      : "another process holds it";
  return (
    `shared-mode port ${config.httpPort} on ${config.httpHost} is in use: ${holder} — ` +
    "stop that server (in Claude Code: close the other window that runs it), or give this one another port " +
    "(httpPort in ~/.brainferno-mcp-bridge/config.json or BRAINFERNO_MCP_HTTP_PORT; 0 turns shared mode off), then reconnect"
  );
}

/**
 * Builds the runtime and waits until it listens: in shared mode the remote listener, then
 * the panel hub.
 *
 * The order matters. The hub writes the handshake file as soon as it listens, and the panels
 * follow that file. A server that took the file and then could not bind the shared-mode port
 * died and left the file pointing at a closed port, so the panels of the server that was
 * still running found nothing on their next reload. The shared-mode port is therefore bound
 * first: a server that cannot get it stops before it has changed anything.
 */
export async function startRuntime(config: Config): Promise<StartedRuntime> {
  let rt: Runtime | null = null;
  let remote: RunningHttpServer | null = null;
  if (config.httpPort > 0) {
    try {
      // Remote sessions are marked so raw-script tools fail closed for them (BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS).
      remote = await startHttpServer(
        () => {
          if (rt === null) throw new Error("the server is still starting — try again in a moment");
          return createMcpServer(rt, { remote: true });
        },
        { host: config.httpHost, port: config.httpPort, token: config.httpToken },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Error(sharedPortInUseMessage(config), { cause: error });
      throw error;
    }
  }
  try {
    rt = buildRuntime(config);
    await rt.bridge.ready();
  } catch (error) {
    if (remote !== null) await remote.close().catch(() => undefined);
    // close() removes the handshake file when it is ours, so nothing points at this server.
    if (rt !== null) await rt.bridge.close().catch(() => undefined);
    throw error;
  }
  return { rt, remote };
}
