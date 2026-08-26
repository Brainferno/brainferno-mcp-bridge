import type { AppId } from "../apps.js";

/** A JSON value, as returned across the bridge from a host application. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EvalOptions {
  /** Override the configured timeout for this one call. */
  timeoutMs?: number;
}

/**
 * A live connection to one running Creative Cloud application.
 *
 * Implementations are responsible for delivering a script to the host and
 * returning whatever it evaluated to, parsed as JSON.
 */
export interface AppBridge {
  readonly appId: AppId;
  /** Whether a host is currently reachable through this bridge. */
  isConnected(): boolean;
  /** Send a script to the host and resolve with its result. */
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

/** Raised when the host received the script but the script itself threw. */
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
  constructor(appId: AppId, timeoutMs: number) {
    super(
      `"${appId}" did not return a result within ${timeoutMs}ms. ` +
        `A modal dialog open in the application will block scripting until dismissed.`,
    );
    this.name = "EvalTimeoutError";
  }
}
