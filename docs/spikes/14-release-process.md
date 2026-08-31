# Releasing to npm — live run (2026-08-30, three releases in one day)

`v0.2.0`, `v0.2.1` and `v0.2.2` were cut back to back, which was enough repetition to learn
what the process actually does versus what it looks like it does. `publish.yml` is the whole
release: a `vX.Y.Z` tag runs the tests, checks the tag against both package versions,
publishes both packages to npm over OIDC trusted publishing (no stored token), packs the
tarballs and creates the GitHub release from the matching `CHANGELOG.md` section. Each run
took **36–43 s** end to end.

## The two phases, and where the line is

Everything up to the tag is an ordinary commit you can amend. **Pushing the tag is the
irreversible act**: npm permanently burns a version number, even if you unpublish it, and
unpublish is only possible within 72 hours and only when nothing depends on the package.
After that `npm deprecate` is the only tool. The git tag and the GitHub release are both
deletable; the npm version is not.

Phase 1 (reversible): bump the versions, cut the changelog heading, run the gates locally,
commit, push, wait for CI. Phase 2: `git tag -a vX.Y.Z && git push origin vX.Y.Z`.

## Gotchas, in the order they bit

**Four version spots, not three.** `package.json` (root, private), `packages/protocol`,
`packages/server`, **and** the `@brainferno/mcp-bridge-protocol` dependency inside
`packages/server/package.json`, which is pinned to an exact version — miss it and the new
server ships depending on the previous protocol. Then `npm install` to refresh
`package-lock.json`. The workflow's own gate (tag == server version == protocol version)
catches the first three but not the pin, because the pin is not one of the things it compares.

**Simulate the gates before tagging.** All of them run locally in under a minute, and a
failure after the tag is a burned version number:

    npm run typecheck && npm run build && npx vitest run
    node -p "require('./packages/server/package.json').version"      # must equal the tag
    npm pack -w packages/server --dry-run                            # filename proves the version
    awk -v tag=vX.Y.Z '$0 ~ "^## " tag "([ —-]|$)" {on=1;next} on && /^## / {exit} on {print}' CHANGELOG.md

That last one is the release notes. If the `## vX.Y.Z — <date>` heading does not match, the
release is created with a "see the commit list" placeholder instead.

**npm takes minutes to catch up, and lies convincingly in the meantime.** Measured across the
three releases: the version endpoint went live **45 s (0.2.1)** to **2 min (0.2.2)** after the
publish step reported success, and the `latest` dist-tag lagged a further **~3.5 min** on
0.2.2. Consequences, all observed:
- `npm view <pkg> version` and `curl registry.npmjs.org/<pkg>/<version>` return the *old*
  version / **404** while the publish is genuinely complete. The publish log's `+ pkg@version`
  line is the ground truth.
- `npm install -g <pkg>` still fetches the previous version until the dist-tag moves.
- A client with a cached packument reports `npm error code ETARGET  No matching version found`
  for a version that demonstrably exists. `--prefer-online` gets past it.
- The bigger package lags more: `npm notice Your package is being processed and may take a few
  minutes to become available` appears for the ~193 kB server package, never for the ~5.6 kB
  protocol package, which is always live immediately. **Protocol visible and server missing is
  the normal intermediate state, not a half-publish.**

**The half-publish is still the real risk.** Protocol publishes first; if the server publish
then failed, the versions would have to be equal to publish again, so recovery is to bump both
to the next patch and re-tag, leaving an orphaned protocol version on npm (`npm deprecate` it).
Everything is gated behind the full test run, so this has not happened — but it is the one
failure mode worth rehearsing.

**`npm publish` "corrected" the `bin` paths on every release** — `"bin[x]" script name
dist/index.js was invalid and removed` — which reads like data loss and is not: npm strips a
leading `./`. Confirmed against the published tarballs that both commands survived. Dropping
the `./` in `package.json` silences it (0.2.1).

## The publish workflow's test gate is single-platform

`publish.yml` runs `npm test` once, on its Ubuntu runner. `ci.yml` is what covers Windows and
macOS. So **a platform-specific test failure does not block a release**: 0.2.2 published green
while `ci.yml` was red on both Windows legs, because the failing test — a directory walk using
`new URL(...).pathname`, which yields `/D:/a/...` on Windows and scandirs as `D:\D:\a\...` —
only breaks there. The shipped artifact was fine (the bug was in the test, and the released
0.2.2 was separately installed from npm and driven over MCP), but the gate did not catch it and
would not have caught a real Windows regression either.

**Closed after 0.2.2**: `publish.yml` now has a `ci-green` job that every other job needs. It
polls the GitHub API for the newest `ci.yml` run on the tagged commit — `ci.yml` runs on tag
pushes too, so there is always one — waits while it is queued or running, and fails the whole
workflow unless it concluded `success`, with a 30-minute ceiling. Nothing is published before
Windows and macOS have gone green. Newest run wins, so re-running CI after a fix unblocks it.
The gate's script was run against a known-green and a known-red commit before shipping: exit 0
and exit 1 respectively.

## Verifying a release, which is the part that found a real bug

The workflow's green tick means the steps ran, not that the artifact works. Install it and
make it talk:

    npm install -g brainferno-mcp-bridge --prefix /tmp/t --prefer-online

then spawn `/tmp/t/bin/brainferno-mcp-bridge` with **`HOME` pointed at a scratch directory**
and speak JSON-RPC over stdio: `initialize`, `notifications/initialized`, `tools/list`. Expect
113 tools (ps 18, ae 24, pp 28, ai 7, au 12, ame 6, audio 9, pipeline 4, cc 5) and the version
you just shipped.

The isolated `HOME` is not optional on a machine that already runs this server:
- without it the test instance reads the real `config.json`, tries to bind the shared-mode
  port `7898` the live server already holds, and dies with `EADDRINUSE` — the panel-hub port
  falls back to an OS-assigned one, the remote port is fatal by design;
- and it overwrites `~/.brainferno-mcp-bridge/bridge.json`, pointing every panel at a dead
  port on its next reload.

**What this caught:** 0.2.1 introduced itself as `brainferno-mcp-bridge 0.1.0`. The version was
typed out in four files — the MCP `serverInfo`, the welcome frame panels receive, and two
client-identity strings — and none had moved since the first release, so every client and every
panel had been told the wrong version for the life of the project. No test could notice: they
all agreed with the same wrong constant. Fixed in 0.2.2 by reading `package.json` at runtime
(`src/version.ts`) with a test that pins the value *and* fails if a literal `version: "x.y.z"`
reappears in the server source.

The general lesson, worth more than the bug: **a fact that lives in more than one file will
drift, and only an end-to-end question put to the built artifact will tell you.** The same
reasoning retired the hand-maintained version in the README's status line — the npm badge
already tracked it, and the prose had gone stale twice in a day.
