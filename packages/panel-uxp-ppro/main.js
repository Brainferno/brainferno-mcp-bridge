/*
 * Brainferno MCP Bridge — Premiere Pro panel (UXP). The connection logic
 * lives in the shared bridge-client.js (vendored by `npm run panels:sync`);
 * this file holds only what is Premiere-specific: reading the handshake file,
 * logging, UI, and wiring the named commands from commands.js.
 *
 * Premiere UXP has no script engine, so — like Photoshop — every command is a
 * named function; the server never sends script strings here.
 */

const PANEL_VERSION = "0.1.0";

const el = (id) => document.getElementById(id);
const logEl = el("log");

function homeDir() {
  try {
    return require("os").homedir().split("\\").join("/");
  } catch (e) {
    // Fall back to the plugin data folder (.../Users/<name>/AppData/... or .../Users/<name>/Library/...).
    const p = String(require("uxp").storage.localFileSystem.getDataFolder().nativePath || "").split("\\").join("/");
    const m = p.match(/^(.*?\/Users\/[^/]+)\//);
    if (m) return m[1];
    throw e;
  }
}

// ---- logging (panel + mirror file; UXP fs has writeFileSync but no append) --
let LOG_PATH = null;
let logBuffer = "";
let logWriteError = null;
function log(msg) {
  const line = "[" + new Date().toLocaleTimeString() + "] " + msg;
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  console.log(line);
  logBuffer += line + "\n";
  try {
    if (LOG_PATH === null) LOG_PATH = homeDir() + "/.brainferno-mcp-bridge/panel-premiere.log";
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

// ---- bridge client -------------------------------------------------------
const bridge = AcmBridgeClient.create({
  appId: "premiere",
  panelVersion: PANEL_VERSION,
  commands: AcmPremiereCommands,
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
