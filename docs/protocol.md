# Bridge wire protocol — v2 (FROZEN)

This is the contract between the `adobe-cc-mcp` server's hub and the companion panel
inside each Creative Cloud application. It is **frozen**: every panel codebase (UXP and
CEP) is built against it, so a change here ripples into all of them. Amend it only through
the protocol-guardian review, and prefer adding a new command name over changing a frame.

Source of truth: [`src/bridge/protocol.ts`](../src/bridge/protocol.ts). `PROTOCOL_VERSION = 2`.
v1 was never shipped to a panel, so there is no backward-compatibility burden.

## Topology

The panel is the **client**; the server hosts the listener. UXP plugins cannot open a
listening socket — they can only dial out — so the panel always connects to the hub, never
the reverse. This also keeps the one trusted listener on the server side, where it is
hardened. Illustrator is the exception: it has no panel and is driven by the server's
OS-script lane (`osascript` / COM), not this protocol.

```
panel  ──ws──▶  hub          hub ──ws──▶  panel
  hello                        welcome
  result / progress            cmd
  ping / pong / bye            ping / bye
```

## Connection lifecycle

1. **Upgrade.** The hub validates the HTTP upgrade before accepting the socket: any web
   `Origin` (`http(s)://…`) is rejected `403`, and any non-loopback `Host` is rejected
   `403` (DNS-rebinding guard). Panels send no web Origin.
2. **Discover.** The panel reads `~/.adobe-cc-mcp/bridge.json` (the handshake file) to
   learn the port and token. It is written mode-600 when the server starts listening.
3. **Hello.** Within **3 s** the panel MUST send a `hello` carrying the token (in the frame,
   or as `?token=` on the upgrade URL — UXP WebSockets cannot set headers). Any other frame
   before a valid hello, a bad/missing token, an unknown `appId`, or a protocol-version
   mismatch closes the socket (see close codes). A late hello closes on the deadline.
4. **Welcome.** The hub replies `welcome` with the heartbeat interval, registers the panel
   for its `appId` (displacing any previous panel for that app with close `4004`), and is
   ready to send commands.
5. **Heartbeat.** The hub pings every `heartbeatIntervalMs`; the panel replies `pong` (any
   inbound frame also counts as liveness). After 2 missed pings the socket is terminated
   and its in-flight commands are rejected.

## Frames

All panel→server frames are zod-validated; a malformed frame is dropped (and, before auth,
closes the socket).

### panel → server

| Frame | Fields |
| --- | --- |
| `hello` | `protocolVersion`, `appId`, `hostVersion?`, `panelVersion?`, `token?`, `capabilities?: string[]` |
| `result` | `id`, `ok`, `value?`, `error?: {code, message, line?}`, `appState?: {activeDocument?, selection?, dirty?}` |
| `progress` | `id`, `progress?`, `total?`, `message?` |
| `pong` / `ping` | `ts?` |
| `bye` | `reason?` |

### server → panel

| Frame | Fields |
| --- | --- |
| `welcome` | `protocolVersion`, `serverVersion`, `heartbeatIntervalMs` |
| `cmd` | `id` (uuid), `name`, `params`, `timeoutClass: "fast" \| "slow" \| "render"` |
| `ping` | `ts` |
| `bye` | `reason` |

## Commands are named, not raw script

The hub sends `{name, params}`; the panel maps `name` to a local function. UXP restricts
`eval`, and the Premiere UXP API has no script engine, so shipping script strings does not
work there. ExtendScript-engine panels (After Effects, Audition) implement the generic
`eval` command (`params: {script}`) via `evalScript` — a host API, not JS `eval`. Hot-path
commands are promoted to named panel functions over time. A panel advertises the command
names it implements in `hello.capabilities`; the server turns an unimplemented command into
a structured "update the panel" error rather than a hang.

## Hub rules

- **Per-socket correlation.** Pending calls live on the issuing socket. A `result` only
  settles a call if it arrives on the same socket the `cmd` went out on — one panel can
  never settle another's in-flight call.
- **Per-app serialization.** Commands to one app run one at a time (a single ExtendScript /
  modal scope per host); different apps run concurrently.
- **Timeout classes.** `fast` ≈ 10 s, `slow` = the configured default (30 s), `render` = no
  socket deadline (renders rely on the disconnect/heartbeat cleanup until the job registry
  owns their lifecycle). An explicit per-call `timeoutMs` overrides the class.
- **App not connected** is a fast, structured error (< 100 ms), never a timeout.

## Result error codes

The `error.code` on a failed `result` is a short machine string, e.g. `HOST_ERROR`
(the script threw), `UNKNOWN_COMMAND` (panel does not implement `name`), `BUSY`, `KILLED`
(kill switch engaged). `message` is human-readable; `line` is optional.

## WebSocket close codes

| Code | Meaning |
| --- | --- |
| `4001` | Unauthorized — bad/missing token, a frame before hello, or the auth deadline elapsed |
| `4002` | Unknown `appId` |
| `4003` | Protocol version mismatch |
| `4004` | Replaced by a newer connection for the same app |
| `1000` | Normal close (e.g. `bye`) |
