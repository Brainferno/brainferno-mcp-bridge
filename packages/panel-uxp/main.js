/*
 * adobe-cc-mcp Photoshop panel (UXP). The connection logic lives in the shared
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
const LOG_PATH = homeDir() + "/.adobe-cc-mcp/panel-photoshop.log";
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
  const hs = JSON.parse(require("fs").readFileSync(homeDir() + "/.adobe-cc-mcp/bridge.json", "utf-8"));
  log("handshake read OK: port=" + hs.port + " protocol=" + hs.protocolVersion + " pid=" + hs.pid);
  return hs;
}

// ---- named commands (protocol v2) ----------------------------------------
const commands = {
  "ps.list_documents": async () => {
    const { app } = require("photoshop");
    const docs = [];
    for (const doc of app.documents) {
      docs.push({
        id: doc.id,
        name: doc.name,
        path: doc.path || null,
        width: doc.width,
        height: doc.height,
        resolution: doc.resolution,
        mode: String(doc.mode),
        layerCount: doc.layers.length,
      });
    }
    return docs;
  },
  "ps.list_layers": async (params) => {
    const { app } = require("photoshop");
    const wanted = params && params.documentId != null ? params.documentId : null;
    let doc = app.activeDocument;
    if (wanted !== null) {
      doc = null;
      for (const d of app.documents) if (d.id === wanted) doc = d;
      if (!doc) throw new Error("Document " + wanted + " not found");
    }
    if (!doc) throw new Error("No open document");
    const out = [];
    const walk = (layers, depth) => {
      for (const layer of layers) {
        out.push({ id: layer.id, name: layer.name, kind: String(layer.kind), visible: layer.visible, opacity: layer.opacity, depth });
        if (layer.layers) walk(layer.layers, depth + 1);
      }
    };
    walk(doc.layers, 0);
    return out;
  },
  "ps.host_info": async () => {
    const uxp = require("uxp");
    return { app: uxp.host.name, version: uxp.host.version, uxpVersion: uxp.versions && uxp.versions.uxp };
  },
};

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
