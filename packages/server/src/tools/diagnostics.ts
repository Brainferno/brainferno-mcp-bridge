import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { APPS, APP_IDS, PROTOCOL_VERSION, type AppId } from "@brainferno/mcp-bridge-protocol";
import type { BridgeServer } from "../bridge/socket.js";
import type { AppBridge } from "../bridge/types.js";
import type { RawScriptApp } from "../config.js";
import { MAX_EXPLICIT_TIMEOUT_MS, NO_RESULT_MESSAGE } from "../drivers/osscript.js";
import { SERVER_VERSION } from "../version.js";
import {
  ILLUSTRATOR_RAW_NO_RESULT_MESSAGE,
  auditRawCall,
  dispatchedFailure,
  envelopeResult,
  rawGateState,
  rawScriptWrapper,
  toEnvelope,
  viaOf,
} from "./raw-script.js";
import { errorResult, guard, jsonResult } from "./result.js";

export interface DiagnosticOptions {
  /**
   * Apps whose tools are registered (cc_connected_apps lists these). Required, with no
   * fallback: the raw-script gate refuses any app not listed here before touching a lane.
   */
  enabledApps: readonly AppId[];
  /** Apps the raw-script gate (BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS) opens. Empty = cc_eval_script refuses every call. */
  rawScriptApps: readonly RawScriptApp[];
  /** Gate tokens that named no raw-capable app; reported by cc_get_capabilities. */
  rawScriptIgnored: readonly string[];
  /** BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS: whether a remote session may run raw scripts. */
  allowRemoteRawScripts: boolean;
  /** This McpServer serves a remote (shared HTTP) session. */
  remote: boolean;
  /**
   * The os-script lane Illustrator's raw scripts go through — the SAME instance the ai_*
   * tools use, so its per-host queue serializes them. An interface so tests can inject one.
   */
  illustratorBridge: AppBridge;
  /** Whether the Illustrator delegate key is configured (never the key itself). */
  illustratorDelegateEnabled: boolean;
}

/** Host ids whose engine can evaluate a raw ExtendScript string. */
const RAW_SCRIPT_APP_IDS = APP_IDS.filter((id) => APPS[id].engine === "extendscript") as [AppId, ...AppId[]];

const DELEGATE_TOOLS = ["ai_beta_status", "ai_beta_list_tools", "ai_beta_call"] as const;
const DELEGATE_ENABLE_WITH =
  "Set BRAINFERNO_MCP_ILLUSTRATOR_KEY (Illustrator > MCP & Tools) or rerun npm run install-cc, then restart.";

/**
 * Cross-application tools: which hosts are reachable, what this server can do for the
 * calling session, and a gated raw-script escape hatch for work the typed tools do not
 * cover yet.
 */
export function registerDiagnosticTools(
  server: McpServer,
  bridge: BridgeServer,
  options: DiagnosticOptions,
): void {
  const enabled: readonly AppId[] = options.enabledApps;
  const session = { remote: options.remote, allowRemote: options.allowRemoteRawScripts };

  server.registerTool(
    "cc_connected_apps",
    {
      title: "Creative Cloud: connected applications",
      description:
        "List all five Creative Cloud applications, how each is reached (a UXP or CEP panel over the bridge, or " +
        "direct OS scripting), and whether it is currently connected. Call this first when a tool reports that an " +
        "application is not connected.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const connected = new Set(bridge.connectedApps());
        return jsonResult(
          enabled.map((id) => ({
            appId: id,
            displayName: APPS[id].displayName,
            lane: APPS[id].lane,
            panel: APPS[id].panel ?? null,
            engine: APPS[id].engine,
            connected: APPS[id].lane === "os-script" ? null : connected.has(id),
          })),
        );
      }),
  );

  server.registerTool(
    "cc_get_capabilities",
    {
      title: "Creative Cloud: capabilities and gates",
      description:
        "Report what this server can do for the calling session, without contacting any application: the server " +
        "and protocol versions; whether this session is local (stdio) or remote (shared HTTP); the raw-script gate " +
        "(BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS: enabled apps, ignored tokens, whether remote sessions are allowed); one " +
        "row per gated tool (cc_eval_script per ExtendScript app, ps_batch_play, the Illustrator delegate tools) " +
        "saying whether it is enabled for this session, how to enable it, whether its app is connected and whether " +
        "the connected panel implements the command; and each panel's version and host version. Call it before " +
        "relying on a raw-script tool.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const connected = new Set(bridge.connectedApps());
        const isConnected = (app: AppId): boolean | null => (APPS[app].lane === "socket" ? connected.has(app) : null);
        const panelSupports = (app: AppId, cmd: string): boolean | null =>
          APPS[app].lane === "socket" && connected.has(app) ? (bridge.panelInfo(app)?.capabilities?.includes(cmd) ?? null) : null;
        const rawRow = (tool: string, app: AppId, cmd: string) => {
          const gate = rawGateState(app, options.rawScriptApps, enabled, session);
          return {
            tool,
            app,
            enabled: gate.open,
            enableWith: gate.open ? null : gate.reason,
            connected: isConnected(app),
            panelSupports: panelSupports(app, cmd),
          };
        };

        const tools: {
          tool: string;
          app: AppId;
          enabled: boolean;
          enableWith: string | null;
          connected: boolean | null;
          panelSupports: boolean | null;
        }[] = [];
        for (const app of RAW_SCRIPT_APP_IDS) if (enabled.includes(app)) tools.push(rawRow("cc_eval_script", app, "eval"));
        if (enabled.includes("photoshop")) tools.push(rawRow("ps_batch_play", "photoshop", "ps.batch_play"));
        if (enabled.includes("illustrator")) {
          for (const tool of DELEGATE_TOOLS) {
            tools.push({
              tool,
              app: "illustrator",
              enabled: options.illustratorDelegateEnabled,
              enableWith: options.illustratorDelegateEnabled ? null : DELEGATE_ENABLE_WITH,
              connected: null,
              panelSupports: null,
            });
          }
        }

        const panels = enabled
          .filter((app) => APPS[app].lane === "socket")
          .map((app) => {
            const info = bridge.panelInfo(app);
            return {
              appId: app,
              connected: connected.has(app),
              panelVersion: info?.panelVersion ?? null,
              hostVersion: info?.hostVersion ?? null,
            };
          });

        return jsonResult({
          serverVersion: SERVER_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          session: options.remote ? "remote" : "stdio",
          rawScriptGate: {
            env: "BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS",
            apps: [...options.rawScriptApps],
            ignored: [...options.rawScriptIgnored],
            remoteAllowed: options.allowRemoteRawScripts,
          },
          tools,
          panels,
        });
      }),
  );

  server.registerTool(
    "cc_eval_script",
    {
      title: "Creative Cloud: evaluate a raw ExtendScript",
      description:
        "Run a raw ExtendScript (ES3: var only — no let/const, arrow functions, template literals or JSON) in After " +
        "Effects, Illustrator or Audition. An escape hatch for work the typed tools do not cover — prefer a typed tool " +
        "where one exists. Photoshop has ps_batch_play instead; Premiere Pro has no raw-script path.\n" +
        "The completion value of the script's last statement is returned (a top-level `return` is a SyntaxError — " +
        "wrap such code in an IIFE). Call __log(msg) to collect up to 200 lines / 20000 characters (logsDropped " +
        "counts the rest). The result must be plain data — strings, numbers, booleans, null, arrays and plain " +
        "objects; a host object (a layer, a comp, a Date) is refused with its path, so copy the fields you need. " +
        "Variables and functions the script declares stay local to the call; assigning to an undeclared name " +
        "creates a global that persists in the host.\n" +
        "Returns the envelope { ok, error?: { message, line, bodyLine }, durationMs, value, logs, logsDropped? }. " +
        "bodyLine is the line in your script that failed. bodyLine is null when the error was raised outside your " +
        "script's own text (for example in a $.evalFile'd library, or in a helper an earlier call left as a global) " +
        "or the host's line numbering cannot be calibrated. " +
        "durationMs is the server round trip, including any wait behind other calls to the same app (and, for " +
        "Illustrator, starting the OS script runner — which launches Illustrator if it is closed).\n" +
        "Error shape: an error with plain text means nothing was dispatched (raw scripts disabled, app not enabled, " +
        "app not connected); an error whose text is a JSON envelope means the script was sent and may have partly run.\n" +
        "Refused unless the operator sets BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS (1, or a comma list of app ids) in the MCP " +
        "server env; remote (shared HTTP) sessions are also refused unless BRAINFERNO_MCP_ALLOW_REMOTE_RAW_SCRIPTS=1. " +
        "cc_get_capabilities shows the gate. Every call, run or refused, writes an audit line to the server log.",
      inputSchema: {
        appId: z.enum(RAW_SCRIPT_APP_IDS).describe("Which ExtendScript host to run the script in."),
        script: z
          .string()
          .min(1)
          .describe(
            "ExtendScript (ES3) source. The value of its last statement is returned; call __log(msg) to collect log lines.",
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(MAX_EXPLICIT_TIMEOUT_MS)
          .optional()
          .describe("Override the result timeout for this call, in ms (default: the server's slow timeout; max 30 minutes)."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ appId, script, timeoutMs }, extra) => {
      const via = viaOf(extra);
      const gate = rawGateState(appId, options.rawScriptApps, enabled, session);
      if (!gate.open) {
        // Refused before any bridge is touched: nothing is dispatched, so plain text.
        auditRawCall({ tool: "cc_eval_script", app: appId, payload: script, outcome: "refused", via });
        return errorResult(gate.reason);
      }
      auditRawCall({ tool: "cc_eval_script", app: appId, payload: script, outcome: "run", via });
      const osScript = APPS[appId].lane === "os-script";
      const target = osScript ? options.illustratorBridge : bridge.bridgeFor(appId);
      return guard(async () => {
        const t0 = Date.now();
        try {
          const raw = await target.evaluate(rawScriptWrapper(script), { timeoutClass: "slow", timeoutMs });
          return envelopeResult(toEnvelope(raw, script, Date.now() - t0));
        } catch (error) {
          const env = dispatchedFailure(error, Date.now() - t0, {
            noun: "the script",
            onScriptError: (message) =>
              // The lane's "probably failed to parse" cannot be a raw script's cause: the wrapper
              // reports the caller's syntax errors as ok:false.
              osScript && message === NO_RESULT_MESSAGE
                ? ILLUSTRATOR_RAW_NO_RESULT_MESSAGE
                : `${message} — the script was sent; it may have partly run`,
          });
          if (env !== null) return envelopeResult(env);
          // A plain AppNotConnectedError (nothing was dispatched) and anything else: guard() → plain text.
          throw error;
        }
      });
    },
  );
}
