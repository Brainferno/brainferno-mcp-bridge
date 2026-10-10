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
  /**
   * Increments each time a panel for this app completes its hello (0 before the first). Lets callers
   * drop host facts cached under an earlier connection — the operator may have restarted the app,
   * installed a plugin or switched versions. Optional: lanes without panels omit it.
   */
  connectionEpoch?(): number;
}

/** A "did you mean" candidate: the name to pass, and an optional human label (e.g. the display name). */
export interface ScriptSuggestion {
  readonly name: string;
  readonly label?: string;
}

/**
 * Facts about a ScriptError beyond the host's text. All optional. Never derived from, and never
 * written into, `message` (raw-script envelopes and NO_RESULT_MESSAGE checks depend on it).
 * guard() renders the enriched form only when `where` is set (AE-16: After Effects tools).
 */
export interface ScriptErrorDetails {
  /** The panel's wire error code (protocol `error.code`: "HOST_ERROR", "UNKNOWN_COMMAND"). Socket lane only. */
  readonly code?: string;
  /** Where the reported line falls in the script the tool generated. Its presence marks the error as enriched. */
  readonly where?: "body" | "helper" | "outside" | "unknown";
  /** where === "body": the failing line of the tool's body; the first body statement is 1. */
  readonly bodyLine?: number;
  /** where === "helper": the shared helper the line falls in, e.g. "__prop". */
  readonly helper?: string;
  /** where === "body": up to 3 rendered lines around bodyLine, the failing one prefixed ">>> "; already redacted and capped. */
  readonly excerpt?: readonly string[];
  /** The MCP tool that issued the script. */
  readonly tool?: string;
  /** One-line echo of the tool's validated arguments, already redacted and capped (tools/echo.ts). Never set for raw-script tools. */
  readonly args?: string;
  /** "Did you mean" candidates, best first, at most 3. */
  readonly suggestions?: readonly ScriptSuggestion[];
  /** One sentence added after the suggestions (e.g. "That effect is installed, but …"). */
  readonly note?: string;
  /**
   * What to do next, set only when the paragraph would not show the message's own step: it has none
   * (no " — " outside quoted names), or the paragraph cuts the message before it (then this is that
   * step). No trailing period.
   */
  readonly next?: string;
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
  readonly details: ScriptErrorDetails;
  constructor(
    public readonly appId: AppId,
    message: string,
    public readonly scriptLine?: number,
    details: ScriptErrorDetails = {},
  ) {
    super(message);
    this.name = "ScriptError";
    this.details = details;
  }

  /** The failing body line, or null (not enriched, or the line is not in the tool's body). */
  get bodyLine(): number | null {
    return this.details.bodyLine ?? null;
  }

  /** A copy with `more` merged into `details`; appId, message, scriptLine and stack are kept. */
  withDetails(more: ScriptErrorDetails): ScriptError {
    const copy = new ScriptError(this.appId, this.message, this.scriptLine, { ...this.details, ...more });
    copy.stack = this.stack;
    return copy;
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
