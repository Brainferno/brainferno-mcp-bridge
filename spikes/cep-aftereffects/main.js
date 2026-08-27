/*
 * Spike 2: can a CEP panel (Chromium + Node) dial out to the adobe-cc-mcp hub,
 * authenticate, and run ExtendScript in After Effects on command?
 *
 * Findings this panel surfaces (watch the log):
 *   1. Is Node available (`cep_node` / `require`) with --enable-nodejs?
 *   2. Can it read ~/.adobe-cc-mcp/bridge.json?
 *   3. Does the browser WebSocket connect, and what Origin does CEF send
 *      (the hub logs a 403 if it is not file:// / loopback)?
 *   4. Does evalScript -> __acmEval round-trip JSON, with error + line?
 *
 * Uses window.__adobe_cep__ directly (the API under CSInterface.js) so no
 * Adobe library file needs to ship with the spike.
 */

const PROTOCOL_VERSION = 2;
const PANEL_VERSION = "0.1.0-cep-spike";

const el = (id) => document.getElementById(id);
const logEl = el("log");

// ---- 1. Node ----------------------------------------------------------------
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
const logPath = () => (homeDir() ? homeDir() + "/.adobe-cc-mcp/panel-aftereffects.log" : null);

function log(msg) {
  const line = "[" + new Date().toLocaleTimeString() + "] " + msg;
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  console.log(line);
  try {
    if (nodeFs && logPath()) nodeFs.appendFileSync(logPath(), line + "\n", "utf8");
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
const cep = typeof window !== "undefined" ? window.__adobe_cep__ : undefined;

function evalScript(src) {
  return new Promise((resolve) => {
    if (!cep) {
      resolve("EvalScript error: __adobe_cep__ missing");
      return;
    }
    cep.evalScript(src, (res) => resolve(res));
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

// ---- 2. handshake --------------------------------------------------------
function readHandshake() {
  try {
    if (!nodeFs) throw new Error("Node fs not available (is --enable-nodejs set?)");
    const hs = JSON.parse(nodeFs.readFileSync(homeDir() + "/.adobe-cc-mcp/bridge.json", "utf8"));
    log("handshake read OK: port=" + hs.port + " protocol=" + hs.protocolVersion + " pid=" + hs.pid);
    return hs;
  } catch (e) {
    log("handshake read FAILED: " + (e && e.message ? e.message : e));
    return null;
  }
}

// ---- commands ------------------------------------------------------------
const commands = {
  eval: async (params) => {
    const script = params && params.script;
    if (typeof script !== "string") throw new Error("eval needs params.script");
    return hostEval(script);
  },
  "ae.host_info": async () => JSON.parse(await evalScript("__acmHostInfo()")),
};

// ---- 3. socket -----------------------------------------------------------
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
  if (!token) log("no token — start the server so it writes the handshake file, or paste one");

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
  const sock = ws;

  ws.onopen = async () => {
    log("socket open — sending hello");
    let hostVersion = "";
    try {
      hostVersion = (await commands["ae.host_info"]()).version || "";
    } catch (e) {
      log("host_info failed: " + (e && e.message ? e.message : e));
    }
    sock.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        appId: "after_effects",
        hostVersion,
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
      sock.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      return;
    }
    if (frame.type === "cmd") {
      log("cmd " + frame.name + " (" + frame.id.slice(0, 8) + ")");
      const handler = commands[frame.name];
      if (!handler) {
        sock.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error: { code: "UNKNOWN_COMMAND", message: "panel does not implement " + frame.name } }));
        return;
      }
      try {
        const value = await handler(frame.params);
        sock.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value }));
        log("  -> ok");
      } catch (e) {
        sock.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error: { code: "HOST_ERROR", message: e && e.message ? e.message : String(e), line: e && e.line ? e.line : undefined } }));
        log("  -> error: " + (e && e.message ? e.message : e));
      }
      return;
    }
    if (frame.type === "bye") log("server said bye: " + frame.reason);
  };

  ws.onerror = (e) => log("socket error: " + (e && e.message ? e.message : JSON.stringify(e)));
  ws.onclose = (ev) => {
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

el("connect").addEventListener("click", () => connect());
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

// ---- boot ---------------------------------------------------------------
log("---- panel loaded (" + PANEL_VERSION + ") ----");
log("node: " + (nodeRequire ? "available" : "NOT available") + (nodeFs ? " (fs ok)" : ""));
log("__adobe_cep__: " + (cep ? "present" : "MISSING"));
(async () => {
  try {
    const info = await commands["ae.host_info"]();
    log("host: " + JSON.stringify(info));
    const probe = await hostEval("(function(){ return { two: 1 + 1, comps: app.project.numItems }; })()");
    log("evalScript JSON round trip OK: " + JSON.stringify(probe));
    try {
      await hostEval("(function(){ throw new Error('deliberate'); })()");
    } catch (e) {
      log("error propagation OK: " + e.message + " (line " + e.line + ")");
    }
  } catch (e) {
    log("host probe FAILED: " + (e && e.message ? e.message : e));
  }
  connect();
})();
