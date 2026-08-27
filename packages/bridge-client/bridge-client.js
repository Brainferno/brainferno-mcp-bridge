/*
 * adobe-cc-mcp bridge client — the dial-out half of protocol v2, shared by
 * every in-app panel (UXP: Photoshop/Premiere; CEP: After Effects/Audition).
 *
 * Plain script, no module system, no syntax newer than ES2017: it runs inside
 * UXP's JS engine and CEP's Chromium 99. Panels include it with a <script>
 * tag (it is vendored into each panel folder by `npm run panels:sync`) and
 * call AcmBridgeClient.create({...}).
 *
 * The client owns: reading the handshake file (via a host-provided reader),
 * connecting, the hello/welcome handshake, ping/pong, dispatching `cmd`
 * frames to the panel's named command functions, one retry loop with backoff,
 * and the kill switch. The panel owns: the host-specific command
 * implementations, logging, and UI.
 */
(function (global) {
  "use strict";

  var PROTOCOL_VERSION = 2;

  /**
   * options:
   *   appId          "photoshop" | "premiere" | "after_effects" | "audition"
   *   panelVersion   string shown to the server
   *   commands       { name: async function(params) -> value }
   *   readHandshake  function() -> { port, token, protocolVersion, pid } | null
   *   hostVersion    async function() -> string   (optional)
   *   overrides      function() -> { port?, token? } (optional; UI fields)
   *   log            function(message)
   *   onStatus       function("disconnected"|"connecting"|"connected"|"error")
   *   retryMs        number, default 3000
   */
  function create(options) {
    var ws = null;
    var killed = false;
    var reconnectTimer = null;
    var log = options.log || function () {};
    var onStatus = options.onStatus || function () {};
    var retryMs = options.retryMs || 3000;
    var commands = options.commands || {};

    function send(sock, frame) {
      try {
        sock.send(JSON.stringify(frame));
      } catch (e) {
        log("send failed: " + (e && e.message ? e.message : e));
      }
    }

    function scheduleRetry() {
      if (killed) return;
      log("reconnecting in " + retryMs / 1000 + "s …");
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        if (!killed && !ws) connect();
      }, retryMs);
    }

    function handleCmd(sock, frame) {
      log("cmd " + frame.name + " (" + String(frame.id).slice(0, 8) + ")");
      var handler = commands[frame.name];
      if (!handler) {
        send(sock, { type: "result", id: frame.id, ok: false, error: { code: "UNKNOWN_COMMAND", message: "panel does not implement " + frame.name } });
        return;
      }
      Promise.resolve()
        .then(function () {
          return handler(frame.params);
        })
        .then(
          function (value) {
            send(sock, { type: "result", id: frame.id, ok: true, value: value === undefined ? null : value });
            log("  -> ok");
          },
          function (e) {
            send(sock, {
              type: "result",
              id: frame.id,
              ok: false,
              error: { code: "HOST_ERROR", message: e && e.message ? e.message : String(e), line: e && e.line ? e.line : undefined },
            });
            log("  -> error: " + (e && e.message ? e.message : e));
          }
        );
    }

    function connect() {
      killed = false;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        log("already connecting/connected");
        return;
      }
      var hs = null;
      try {
        hs = options.readHandshake ? options.readHandshake() : null;
      } catch (e) {
        log("handshake read FAILED: " + (e && e.message ? e.message : e));
      }
      var ov = options.overrides ? options.overrides() || {} : {};
      var port = ov.port || (hs && hs.port) || 7897;
      var token = ov.token || (hs && hs.token) || "";
      if (!token) log("no token — start the server so it writes the handshake file, or paste one");

      var url = "ws://127.0.0.1:" + port;
      log("connecting " + url + " …");
      onStatus("connecting");
      try {
        ws = new WebSocket(url);
      } catch (e) {
        log("WebSocket ctor threw: " + (e && e.message ? e.message : e));
        onStatus("error");
        ws = null;
        scheduleRetry();
        return;
      }
      var sock = ws;

      sock.onopen = function () {
        log("socket open — sending hello");
        var versionPromise = options.hostVersion ? Promise.resolve().then(options.hostVersion) : Promise.resolve("");
        versionPromise.then(
          function (hostVersion) {
            send(sock, {
              type: "hello",
              protocolVersion: PROTOCOL_VERSION,
              appId: options.appId,
              hostVersion: hostVersion || "",
              panelVersion: options.panelVersion || "",
              token: token,
              capabilities: Object.keys(commands),
            });
          },
          function (e) {
            log("hostVersion failed: " + (e && e.message ? e.message : e));
            send(sock, { type: "hello", protocolVersion: PROTOCOL_VERSION, appId: options.appId, panelVersion: options.panelVersion || "", token: token, capabilities: Object.keys(commands) });
          }
        );
      };

      sock.onmessage = function (ev) {
        var frame;
        try {
          frame = JSON.parse(ev.data);
        } catch (e) {
          log("bad frame: " + String(ev.data).slice(0, 80));
          return;
        }
        if (frame.type === "welcome") {
          onStatus("connected");
          log("welcome: server " + frame.serverVersion + ", heartbeat " + frame.heartbeatIntervalMs + "ms");
        } else if (frame.type === "ping") {
          send(sock, { type: "pong", ts: Date.now() });
        } else if (frame.type === "cmd") {
          handleCmd(sock, frame);
        } else if (frame.type === "bye") {
          log("server said bye: " + frame.reason);
        }
      };

      sock.onerror = function (e) {
        log("socket error: " + (e && e.message ? e.message : JSON.stringify(e)));
      };

      sock.onclose = function (ev) {
        // Only the current socket may schedule a retry; a stale one closing
        // late must not start a second loop.
        if (ws !== sock) return;
        onStatus("disconnected");
        log("socket closed: code=" + ev.code + " reason=" + (ev.reason || "(none)"));
        ws = null;
        scheduleRetry();
      };
    }

    function kill() {
      killed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        send(ws, { type: "bye", reason: "kill switch" });
        try {
          ws.close(1000, "kill switch");
        } catch (e) {}
      }
      log("kill switch engaged — no reconnect until you press Connect");
    }

    return {
      connect: connect,
      kill: kill,
      isConnected: function () {
        return ws !== null && ws.readyState === 1;
      },
    };
  }

  global.AcmBridgeClient = { create: create, PROTOCOL_VERSION: PROTOCOL_VERSION };
})(typeof window !== "undefined" ? window : globalThis);
