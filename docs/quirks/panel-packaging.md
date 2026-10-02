# Packaging the panels (.ccx / .zxp)

How the panels are packaged into installable plugins via `npm run package`.

`npm run package` (`scripts/package-panels.mjs`) builds installable panels into
`dist-packages/` (git-ignored), version stamped from the root `package.json` so the
manifests never drift.

- **UXP (Photoshop `panel-uxp`, Premiere `panel-uxp-ppro`) → `.ccx`**: NOT auto-built.
  A `.ccx` is a zip under the hood, but Adobe signs it with its own UXP signer and says
  do NOT hand-zip one — a plain zip fails to install with UPIA **status -267** (confirmed
  live). The signer is in the UXP Developer Tool's **Package** command and in
  `@adobe/uxp-devtools-cli` (`uxp plugin package`), whose native module has no prebuild
  for Node 24 (fails headless here). So `npm run package` only STAGES a version-stamped
  folder `dist-packages/uxp-<app>-<ver>/`; build the `.ccx` from it in the UXP Developer
  Tool (Add Plugin → its manifest.json → Actions → Package), then double-click or
  `UnifiedPluginInstallerAgent.exe /install <file>.ccx`. UPIA won't install a plugin whose
  id is still dev-loaded in UDT — unload it first (that alone was not enough here; the real
  blocker was the missing signature).
- **CEP (`panel-cep`, hosts After Effects + Audition) → self-signed `.zxp`**: signed with
  Adobe's **ZXPSignCmd**, auto-downloaded to `.tools/` from CEP-Resources 4.1.103 (win64 only
  in that build; the macOS binary lives in older version folders — drop it in by hand). The
  cert is generated once (`.tools/brainferno-selfsigned.p12`, password "brainferno",
  git-ignored — never commit). `-selfSignedCert US CA Brainferno "Brainferno MCP Bridge" <pw>
  <p12>` then `-sign <dir> <out.zxp> <p12> <pw>`, verify with `-verify <zxp> -certInfo`.

**Installing (verified live):** Adobe's UPIA installs BOTH formats — `.ccx` AND `.zxp` —
"Installation Successful" for each; no separate ZXP installer needed. UDT names a UXP
package `<plugin-id>_<HOST>.ccx` (e.g. `com.brainferno.mcp-bridge.photoshop_PS.ccx`,
`…premiere_premierepro.ccx`), so Photoshop and Premiere come out distinct. Gotchas: UPIA
refuses an id still dev-loaded in UDT (use **Remove**, not just Unload) and the host app is
best closed. Installed locations: UXP → `…\Roaming\Adobe\UXP\Plugins\External\<id>_<ver>`; CEP
→ `…\Program Files (x86)\Common Files\Adobe\CEP\extensions\<name>`. `install-cc`'s CEP dev
install is a junction at `…\Roaming\Adobe\CEP\extensions\<id>`; remove it with `rmdir` (link
only, never the source) to switch After Effects / Audition onto the installed `.zxp`.

`.tools/` and `dist-packages/` are git-ignored. The old dev-load path still works: UXP via the
UXP Developer Tool, CEP via `npm run install-cc` (junction + PlayerDebugMode). Panel versions
are no longer hardcoded — `npm run panels:stamp` writes the server version into the six panel
version spots and `tool-counts`/panel-version tests fail on drift.
