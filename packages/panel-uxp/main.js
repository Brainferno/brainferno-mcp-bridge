/*
 * brainferno-mcp-bridge Photoshop panel (UXP). The connection logic lives in the shared
 * bridge-client.js (vendored by `npm run panels:sync`); this file holds only
 * what is Photoshop-specific: reading the handshake file with UXP's fs, the
 * named commands implemented against the `photoshop` module, logging, and UI.
 *
 * Facts this build relies on (spike 1, docs/spikes/03-photoshop-uxp.md):
 * UXP cannot evaluate script strings, so every command is a named function;
 * the manifest needs network.domains "all"; the hub accepts Origin file://.
 */

const PANEL_VERSION = "0.2.0";

const el = (id) => document.getElementById(id);
const logEl = el("log");

function homeDir() {
  return require("os").homedir().split("\\").join("/");
}

// ---- logging (panel + mirror file; UXP fs has writeFileSync but no append) --
const LOG_PATH = homeDir() + "/.brainferno-mcp-bridge/panel-photoshop.log";
let logBuffer = "";
let logWriteError = null;
function log(msg) {
  const line = "[" + new Date().toLocaleTimeString() + "] " + msg;
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  console.log(line);
  logBuffer += line + "\n";
  try {
    require("fs").writeFileSync(LOG_PATH, logBuffer, "utf-8");
  } catch (e) {
    if (logWriteError === null) {
      logWriteError = e && e.message ? e.message : String(e);
      logEl.textContent += "[file log unavailable: " + logWriteError + "]\n";
    }
  }
}

function setStatus(state) {
  const b = el("status");
  b.textContent = state;
  b.className = "badge " + (state === "connected" ? "on" : "off");
}

// ---- handshake file --------------------------------------------------------
function readHandshake() {
  const hs = JSON.parse(require("fs").readFileSync(homeDir() + "/.brainferno-mcp-bridge/bridge.json", "utf-8"));
  log("handshake read OK: port=" + hs.port + " protocol=" + hs.protocolVersion + " pid=" + hs.pid);
  return hs;
}

// ---- named commands (protocol v2) — implemented in commands.js -----------
const commands = AcmPhotoshopCommands;

// ---- bridge client -------------------------------------------------------
const bridge = AcmBridgeClient.create({
  appId: "photoshop",
  panelVersion: PANEL_VERSION,
  commands,
  readHandshake,
  hostVersion: async () => require("uxp").host.version,
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
el("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.setContent({ "text/plain": logEl.textContent });
    log("log copied to clipboard");
  } catch (e) {
    log("copy failed: " + (e && e.message ? e.message : e));
  }
});

// ---- layout: size the log box from the real panel height -----------------
// UXP does not size body/flex children to the panel, so measure and set it.
function heightOf(id) {
  const n = el(id);
  if (!n) return 0;
  const r = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
  return (r && r.height ? r.height : n.offsetHeight || 0) + 8;
}
let lastFit = -1;
function fitLog() {
  const total = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
  if (!total) return;
  const used = heightOf("r1") + heightOf("r2") + heightOf("r3") + heightOf("r4") + heightOf("r5") + heightOf("hint") + 20;
  const h = Math.max(40, Math.floor(total - used));
  if (h !== lastFit) {
    lastFit = h;
    logEl.style.height = h + "px";
  }
}
window.addEventListener("resize", fitLog);
setInterval(fitLog, 400);
fitLog();

// ---- boot ---------------------------------------------------------------
log("---- panel loaded (" + PANEL_VERSION + ") ----");
bridge.connect();
