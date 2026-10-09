import type { AppId } from "@brainferno/mcp-bridge-protocol";
import type { TimeoutClass } from "@brainferno/mcp-bridge-protocol";

/** A JSON value, as returned across the bridge from a host application. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EvalOptions {
  /** Override the configured timeout for this one call. */
  timeoutMs?: number;
  /** Command weight class, selecting a default deadline. Defaults to "slow". */
  timeoutClass?: TimeoutClass;
}

/**
 * A live connection to one running Creative Cloud application.
 *
 * The primitive is {@link execute}: it delivers a *named* command and its
 * params to the host and resolves with whatever the host returned, parsed as
 * JSON. {@link evaluate} is a convenience for the generic `eval` command.
 */
export interface AppBridge {
  readonly appId: AppId;
  /** Whether a host is currently reachable through this bridge. */
  isConnected(): boolean;
  /** Send a named command to the host and resolve with its result. */
  execute(name: string, params?: JsonValue, options?: EvalOptions): Promise<JsonValue>;
  /** Convenience wrapper for the generic `eval` command (params `{script}`). */
  evaluate(script: string, options?: EvalOptions): Promise<JsonValue>;
  close(): Promise<void>;
}

/** Raised when no host is reachable for the requested application. */
export class AppNotConnectedError extends Error {
  constructor(public readonly appId: AppId, hint: string) {
    super(`No running host connected for "${appId}". ${hint}`);
    this.name = "AppNotConnectedError";
  }
}

/**
 * The os-script lane's runner (PowerShell/COM, osascript) failed AFTER the script may have
 * reached the host: anything but a failure that provably happened before dispatch (runner
 * missing, COM class not registered, app not running / not found / Automation refused).
 *
 * It extends AppNotConnectedError on purpose: guard() and the typed ai_* tools keep treating
 * it exactly as before, with the same message. Raw-script tools check `dispatched` and answer
 * with the "the script was sent; it may have partly run" envelope instead of plain text.
 */
export class RunnerExitedError extends AppNotConnectedError {
  readonly dispatched = true as const;
  constructor(
    appId: AppId,
    hint: string,
    /** What the runner said (its first stderr line, or "exit <code>"), without the hint. */
    public readonly runnerOutput: string,
  ) {
    super(appId, hint);
    this.name = "RunnerExitedError";
  }
}

/** Raised when a panel disconnected while a command was in flight. */
export class AppDisconnectedError extends Error {
  constructor(
    public readonly appId: AppId,
    reason: string,
  ) {
    super(`The "${appId}" panel disconnected before the command completed (${reason}).`);
    this.name = "AppDisconnectedError";
  }
}

/** Raised when the host received the command but the script itself threw. */
export class ScriptError extends Error {
  constructor(
    public readonly appId: AppId,
    message: string,
    public readonly scriptLine?: number,
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

/** Raised when the host never answered within the timeout. */
export class EvalTimeoutError extends Error {
  constructor(
    appId: AppId,
    /** The deadline that expired, in ms. */
    public readonly timeoutMs: number,
  ) {
    super(
      `"${appId}" did not return a result within ${timeoutMs}ms. ` +
        `A modal dialog open in the application will block scripting until dismissed.`,
    );
    this.name = "EvalTimeoutError";
  }
}
