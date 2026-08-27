/*
 * adobe-cc-mcp CEP panel (After Effects, Audition). The connection logic lives
 * in the shared bridge-client.js (vendored by `npm run panels:sync`); this
 * file holds only what is CEP-specific: Node fs for the handshake file and
 * the log mirror, evalScript into ExtendScript (with host.jsx's __acmEval so
 * results are always JSON with error + line), commands, theme, and UI.
 *
 * Facts this build relies on (spike 2, docs/spikes/04-aftereffects-cep.md):
 * CEP injects a global named `cep` (never redeclare it); Node is available as
 * cep_node / require with --enable-nodejs --mixed-context; ExtendScript allows
 * eval, so the generic `eval` command works here.
 */

const PANEL_VERSION = "0.2.0";

const el = (id) => document.getElementById(id);
const logEl = el("log");

// ---- Node ----------------------------------------------------------------
const nodeRequire =
  (typeof cep_node !== "undefined" && cep_node && cep_node.require) ||
  (typeof require === "function" ? require : null);
let nodeFs = null;
let nodeOs = null;
try {
  nodeFs = nodeRequire ? nodeRequire("fs") : null;
  nodeOs = nodeRequire ? nodeRequire("os") : null;
} catch (e) {
  nodeFs = null;
}
const homeDir = () => (nodeOs ? nodeOs.homedir().split("\\").join("/") : null);

// ---- host id: which CEP host are we in? -----------------------------------
const adobeCep = typeof window !== "undefined" ? window.__adobe_cep__ : undefined;
let hostEnv = null;
try {
  hostEnv = adobeCep ? JSON.parse(adobeCep.getHostEnvironment()) : null;
} catch (e) {
  hostEnv = null;
}
const HOST_ID = hostEnv && hostEnv.appId ? hostEnv.appId : "AEFT";
const APP_ID = HOST_ID === "AUDT" ? "audition" : "after_effects";
const LOG_PATH = homeDir() ? homeDir() + "/.adobe-cc-mcp/panel-" + APP_ID.replace("_", "") + ".log" : null;

function log(msg) {
  const line = "[" + new Date().toLocaleTimeString() + "] " + msg;
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  console.log(line);
  try {
    if (nodeFs && LOG_PATH) nodeFs.appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch (e) {
    /* best effort */
  }
}
function setStatus(state) {
  const b = el("status");
  b.textContent = state;
  b.className = "badge " + (state === "connected" ? "on" : "off");
}

// ---- host bridge --------------------------------------------------------
function evalScript(src) {
  return new Promise((resolve) => {
    if (!adobeCep) {
      resolve("EvalScript error: __adobe_cep__ missing");
      return;
    }
    adobeCep.evalScript(src, (res) => resolve(res));
  });
}

/** Encode a string as a JS literal safe for ExtendScript (escapes U+2028/9). */
function jsLiteral(s) {
  return JSON.stringify(s).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function hostEval(script) {
  const raw = await evalScript("__acmEval(" + jsLiteral(script) + ")");
  if (typeof raw !== "string") throw new Error("evalScript returned " + typeof raw);
  if (raw.indexOf("EvalScript error") === 0) throw new Error(raw);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("host returned non-JSON: " + raw.slice(0, 120));
  }
  if (!parsed.ok) {
    const err = new Error(parsed.error && parsed.error.message ? parsed.error.message : "script failed");
    err.line = parsed.error ? parsed.error.line : null;
    throw err;
  }
  return parsed.value;
}

// ---- handshake -----------------------------------------------------------
function readHandshake() {
  if (!nodeFs) throw new Error("Node fs not available (is --enable-nodejs set?)");
  const hs = JSON.parse(nodeFs.readFileSync(homeDir() + "/.adobe-cc-mcp/bridge.json", "utf8"));
  log("handshake read OK: port=" + hs.port + " protocol=" + hs.protocolVersion + " pid=" + hs.pid);
  return hs;
}

// ---- commands ------------------------------------------------------------
const commands = {
  eval: async (params) => {
    const script = params && params.script;
    if (typeof script !== "string") throw new Error("eval needs params.script");
    return hostEval(script);
  },
  host_info: async () => JSON.parse(await evalScript("__acmHostInfo()")),
};
commands[APP_ID === "audition" ? "au.host_info" : "ae.host_info"] = commands.host_info;

// ---- bridge client -------------------------------------------------------
const bridge = AcmBridgeClient.create({
  appId: APP_ID,
  panelVersion: PANEL_VERSION,
  commands,
  readHandshake,
  hostVersion: async () => (await commands.host_info()).version || "",
  overrides: () => ({ port: el("port").value, token: el("token").value }),
  log,
  onStatus: setStatus,
});

// ---- buttons -------------------------------------------------------------
el("connect").addEventListener("click", () => bridge.connect());
el("kill").addEventListener("click", () => bridge.kill());
el("clear").addEventListener("click", () => {
  logEl.textContent = "";
});
el("copy").addEventListener("click", () => {
  try {
    const ta = document.createElement("textarea");
    ta.value = logEl.textContent;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    log("log copied to clipboard");
  } catch (e) {
    log("copy failed: " + (e && e.message ? e.message : e));
  }
});

// ---- theme: take the panel background from the host's current skin --------
function applyHostTheme() {
  try {
    const env = JSON.parse(adobeCep.getHostEnvironment());
    const c = env.appSkinInfo && env.appSkinInfo.panelBackgroundColor && env.appSkinInfo.panelBackgroundColor.color;
    if (c) document.body.style.backgroundColor = "rgb(" + c.red + "," + c.green + "," + c.blue + ")";
  } catch (e) {
    /* keep the CSS default */
  }
}
applyHostTheme();
try {
  adobeCep.addEventListener("com.adobe.csxs.events.ThemeColorChanged", applyHostTheme, null);
} catch (e) {}

// ---- boot ---------------------------------------------------------------
log("---- panel loaded (" + PANEL_VERSION + ", host " + HOST_ID + ") ----");
log("node: " + (nodeRequire ? "available" : "NOT available") + (nodeFs ? " (fs ok)" : ""));
(async () => {
  try {
    const info = await commands.host_info();
    log("host: " + JSON.stringify(info));
  } catch (e) {
    log("host probe FAILED: " + (e && e.message ? e.message : e));
  }
  bridge.connect();
})();
