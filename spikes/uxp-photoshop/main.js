/*
 * Spike 1: can a UXP panel dial out to the adobe-cc-mcp hub over a localhost
 * WebSocket, authenticate, and answer commands? Throwaway code — it reports
 * what works so the production panel can be built on facts.
 *
 * Findings this panel is designed to surface (watch the log):
 *   1. Does `require("fs")` read ~/.adobe-cc-mcp/bridge.json with fullAccess?
 *   2. Does `new WebSocket("ws://127.0.0.1:PORT")` connect on Windows?
 *   3. Does the hello/welcome/cmd/result protocol v2 round-trip?
 *   4. Can UXP evaluate a script string (`new Function`) — or must every
 *      command be a named, panel-side function?
 *
 * The log is mirrored to ~/.adobe-cc-mcp/panel-photoshop.log so it can be read
 * from outside Photoshop.
 */

const PROTOCOL_VERSION = 2;
const PANEL_VERSION = "0.1.0-spike";

const el = (id) => document.getElementById(id);
const logEl = el("log");

function homeDir() {
  return require("os").homedir().split("\\").join("/");
}

let logFilePath = null;
function logFile() {
  if (logFilePath !== null) return logFilePath;
  try {
    logFilePath = homeDir() + "/.adobe-cc-mcp/panel-photoshop.log";
  } catch (e) {
    logFilePath = "";
  }
  return logFilePath;
}

let logBuffer = "";
let logWriteError = null;
function log(msg) {
  const line = "[" + new Date().toLocaleTimeString() + "] " + msg;
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  console.log(line);
  logBuffer += line + "\n";
  // UXP's fs has writeFileSync but not always appendFileSync: rewrite the
  // whole buffer each time (the log is small). Report the first failure once,
  // in the panel, so a silent no-op is visible.
  try {
    const p = logFile();
    if (p) require("fs").writeFileSync(p, logBuffer, "utf-8");
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

// ---- 1. handshake file --------------------------------------------------
function readHandshake() {
  try {
    const path = homeDir() + "/.adobe-cc-mcp/bridge.json";
    const text = require("fs").readFileSync(path, "utf-8");
    const hs = JSON.parse(text);
    log("handshake read OK: port=" + hs.port + " protocol=" + hs.protocolVersion + " pid=" + hs.pid);
    return hs;
  } catch (e) {
    log("handshake read FAILED: " + (e && e.message ? e.message : e));
    return null;
  }
}

// ---- 4. can UXP eval a string? -----------------------------------------
function evalCapability() {
  try {
    const f = new Function("return 1 + 1");
    const v = f();
    log("new Function works (1+1=" + v + ")");
    return true;
  } catch (e) {
    log("new Function BLOCKED: " + (e && e.message ? e.message : e));
    return false;
  }
}

// ---- named commands (what the production panel will look like) ----------
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
    const host = uxp.host;
    return { app: host.name, version: host.version, uxpVersion: uxp.versions && uxp.versions.uxp };
  },
  // Generic eval: only works if UXP allows new Function (finding #4).
  eval: async (params) => {
    const script = params && params.script;
    if (typeof script !== "string") throw new Error("eval needs params.script");
    const fn = new Function("require", "return (" + script + ")");
    return await fn(require);
  },
};

// ---- 2 + 3. socket + protocol -------------------------------------------
let ws = null;
let killed = false;
let reconnectTimer = null;

async function connect() {
  killed = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    log("already connecting/connected");
    return;
  }
  const hs = readHandshake();
  const port = el("port").value || (hs && hs.port) || 7897;
  const token = el("token").value || (hs && hs.token) || "";
  if (!token) log("no token — set one, or start the server so it writes the handshake file");

  const url = "ws://127.0.0.1:" + port;
  log("connecting " + url + " …");
  setStatus("connecting");
  try {
    ws = new WebSocket(url);
  } catch (e) {
    log("WebSocket ctor threw: " + (e && e.message ? e.message : e));
    setStatus("error");
    return;
  }

  ws.onopen = () => {
    log("socket open — sending hello");
    const uxp = require("uxp");
    ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        appId: "photoshop",
        hostVersion: uxp.host.version,
        panelVersion: PANEL_VERSION,
        token,
        capabilities: Object.keys(commands),
      }),
    );
  };

  ws.onmessage = async (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch (e) {
      log("bad frame: " + String(ev.data).slice(0, 80));
      return;
    }
    if (frame.type === "welcome") {
      setStatus("connected");
      log("welcome: server " + frame.serverVersion + ", heartbeat " + frame.heartbeatIntervalMs + "ms");
      return;
    }
    if (frame.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      return;
    }
    if (frame.type === "cmd") {
      log("cmd " + frame.name + " (" + frame.id.slice(0, 8) + ")");
      const handler = commands[frame.name];
      if (!handler) {
        ws.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error: { code: "UNKNOWN_COMMAND", message: "panel does not implement " + frame.name } }));
        return;
      }
      try {
        const value = await handler(frame.params);
        ws.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value }));
        log("  -> ok");
      } catch (e) {
        ws.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error: { code: "HOST_ERROR", message: e && e.message ? e.message : String(e) } }));
        log("  -> error: " + (e && e.message ? e.message : e));
      }
      return;
    }
    if (frame.type === "bye") {
      log("server said bye: " + frame.reason);
      return;
    }
  };

  const sock = ws;
  ws.onerror = (e) => log("socket error: " + (e && e.message ? e.message : JSON.stringify(e)));
  ws.onclose = (ev) => {
    // Only the socket that is still current may schedule a retry; a stale
    // socket closing late must not start a second retry loop.
    if (ws !== sock) return;
    setStatus("disconnected");
    log("socket closed: code=" + ev.code + " reason=" + (ev.reason || "(none)"));
    ws = null;
    if (!killed) {
      log("reconnecting in 3s …");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!killed && !ws) connect();
      }, 3000);
    }
  };
}

el("connect").addEventListener("click", () => {
  if (ws) {
    log("already connected");
    return;
  }
  connect();
});
el("kill").addEventListener("click", () => {
  killed = true;
  if (ws) {
    try {
      ws.send(JSON.stringify({ type: "bye", reason: "kill switch" }));
    } catch (e) {}
    ws.close(1000, "kill switch");
  }
  log("kill switch engaged — no reconnect until you press Connect");
});
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
  return (r && r.height ? r.height : n.offsetHeight || 0) + 6; // + row margin
}
let lastFit = -1;
function fitLog() {
  const total = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
  if (!total) return;
  const used = heightOf("r1") + heightOf("r2") + heightOf("r3") + heightOf("r4") + heightOf("r5") + heightOf("hint") + 16;
  const h = Math.max(40, Math.floor(total - used));
  if (h !== lastFit) {
    lastFit = h;
    logEl.style.height = h + "px";
  }
}
window.addEventListener("resize", fitLog);
setInterval(fitLog, 400);
fitLog();

log("---- panel loaded (" + PANEL_VERSION + ") ----");
evalCapability();
readHandshake();
connect();
