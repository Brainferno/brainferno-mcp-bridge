# Packaging the panels (.ccx / .zxp)

How the panels are packaged into installable plugins via `npm run package`.

`npm run package` (`scripts/package-panels.mjs`) builds installable panels into
`dist-packages/` (git-ignored), version stamped from the root `package.json` so the
manifests never drift.

- **UXP (Photoshop `panel-uxp`, Premiere Pro `panel-uxp-ppro`) → `.ccx`**: built by
  `npm run package` with no Adobe tool (`scripts/ccx.mjs`), as
  `dist-packages/brainferno-mcp-bridge-<app>-<ver>.ccx`. A `.ccx` is a plain zip of the
  plugin folder with `manifest.json` at the root, and it carries **no signature**. The one
  thing UPIA insists on: **`host` in `manifest.json` must be one object, not a list.** With
  the list that our source manifests use (the form the UXP Developer Tool loads), UPIA
  refuses the file with **status -267**. The UXP Developer Tool's **Package** command makes
  exactly that change and nothing else, which is why its output installed and an earlier
  hand-made zip did not; this note used to blame a missing signature, and that was wrong.
  `scripts/ccx.mjs` writes the manifest with one host object and keeps the source manifest
  as a list. The version-stamped folder `dist-packages/uxp-<app>-<ver>/` is still written,
  for loading in the UXP Developer Tool. UPIA also refuses a plugin whose id is still
  dev-loaded in UDT (use **Remove**, not just Unload).
  - **How this was found (2026-11-04, Windows 11, UPIA from Creative Cloud, Photoshop
    27.11, Premiere Pro 26.5.2):** the two `.ccx` files that UDT packaged on 2026-09-05 are
    still in `dist-packages/`. `zipinfo -v` shows 9 files, no signature entry, no comment
    and no extra data, and 8 of the 9 files are byte-identical to the staged folder; only
    `manifest.json` differs, in `host`. Then, with a test plugin id so that the installed
    panels stayed untouched: a scripted zip with `host` as a list → `Failed to install,
    status = -267`; the same zip with `host` as one object → `Installation Successful`, for
    a Photoshop build and for a Premiere Pro build, with file names that carry no
    `_<HOST>` suffix. `UnifiedPluginInstallerAgent.exe /list all` showed them and
    `/remove "<name>"` took them out again.
  - **The installed panels open and connect (2026-11-04, same machine):** UPIA installed
    the two real files that `npm run package` wrote
    (`brainferno-mcp-bridge-photoshop-0.3.4.ccx`, `…-premiere-0.3.4.ccx`) over the 0.2.2
    panels from September; `/list all` showed 0.3.4 for both and
    `…\UXP\Plugins\External` held only the two `_0.3.4` folders. With the UXP Developer
    Tool not running, Photoshop and Premiere Pro were started, the panel was opened from
    the Plugins menu, and each joined the server: `cc_get_capabilities` reported panel
    version 0.3.4 for both, and one read-only command per app made the round trip through
    the panel (`ps_list_documents` listed the open document; `pp_project_info` came back
    with the panel's own "No project is open", as no project was open).
  - **The same on macOS (2026-11-05, macOS 26.6.2, Photoshop 27.11.0, Premiere Pro 26.5.2,
    Node 26.12.1):** `npm run package` on the Mac wrote the two `.ccx` files and the two
    staged folders, then stopped at the `.zxp` step, because no macOS ZXPSignCmd was in
    `.tools/` (see the CEP bullet below; the `.ccx` part runs first for this reason). The
    operator double-clicked each `.ccx` in Finder and Creative Cloud installed it. Afterwards
    UPIA's `--list all` showed "Brainferno MCP Bridge 0.3.4" as Enabled for Photoshop and for
    Premiere Pro, and `~/Library/Application Support/Adobe/UXP/Plugins/External` held
    `com.brainferno.mcp-bridge.photoshop_0.3.4` and `com.brainferno.mcp-bridge.premiere_0.3.4`.
    `diff -r` against the staged folders of the same run showed one difference in each:
    `manifest.json`, where the installed copy has `host` as one object. With the UXP
    Developer Tool not running, the operator opened each panel from the Plugins menu and
    both joined the 0.3.4 server: `cc_get_capabilities` reported panel version 0.3.4 for
    both, and one read-only command per app made the round trip through the panel
    (`ps_list_documents` returned an empty list, as no document was open; `pp_project_info`
    came back with the panel's own "No project is open").
  - **From the command line on macOS (same day and machine, UPIA 8.6.0.49, Photoshop and
    Premiere Pro both running):** with two test plugins built by `scripts/ccx.mjs` (their
    own ids and names, no script inside, so the installed panels stayed untouched),
    `UnifiedPluginInstallerAgent --install <file>.ccx` answered `Installation Successful`
    for a Photoshop build and for a Premiere Pro build. Installing version 0.3.4 over an
    installed 0.3.3 of the same id also succeeded, and `--list all` then showed 0.3.4. The
    older version's folder stayed in `External` beside the new one: the first
    `--remove "<name>"` took out the 0.3.3 folder (the list still showed 0.3.4), a second
    one took out 0.3.4, and a third answered `Failed to remove …, status = -406`. So after
    an install over an older version, run `--remove` until the name is gone from the list.
  - **Not yet checked on macOS:** an install while the same plugin id is still dev-loaded in
    UDT, and a `.zxp` (no macOS ZXPSignCmd was on the machine). What the Mac had installed
    before the double-click install above was not recorded.
- **CEP (`panel-cep`, hosts After Effects + Audition) → self-signed `.zxp`**: signed with
  Adobe's **ZXPSignCmd**, auto-downloaded to `.tools/` from CEP-Resources 4.1.103 (win64 only
  in that build; the macOS binary lives in older version folders — drop it in by hand). The
  cert is generated once (`.tools/brainferno-selfsigned.p12`, password "brainferno",
  git-ignored — never commit). `-selfSignedCert US CA Brainferno "Brainferno MCP Bridge" <pw>
  <p12>` then `-sign <dir> <out.zxp> <p12> <pw>`, verify with `-verify <zxp> -certInfo`.

**Installing (verified live):** Adobe's UPIA installs BOTH formats — `.ccx` AND `.zxp` —
"Installation Successful" for each; no separate ZXP installer needed. UDT names a UXP
package `<plugin-id>_<HOST>.ccx` (e.g. `com.brainferno.mcp-bridge.photoshop_PS.ccx`,
`…premiere_premierepro.ccx`); UPIA does not need that name. `/list all` shows what is
installed for each app, and `/remove "<plugin name>"` removes one. Gotchas: UPIA
refuses an id still dev-loaded in UDT (use **Remove**, not just Unload) and the host app is
best closed. Installed locations: UXP → `…\Roaming\Adobe\UXP\Plugins\External\<id>_<ver>`; CEP
→ `…\Program Files (x86)\Common Files\Adobe\CEP\extensions\<name>`. On macOS a UXP plugin
lands in `~/Library/Application Support/Adobe/UXP/Plugins/External/<id>_<ver>`, and UPIA is
`/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent`,
with `--install <file>`, `--list all` and `--remove "<plugin name>"` in place of the `/…`
forms (all three run live, 2026-11-05). `npm run package` prints the command for the
platform it runs on. `install-cc`'s CEP dev
install is a junction at `…\Roaming\Adobe\CEP\extensions\<id>`; remove it with `rmdir` (link
only, never the source) to switch After Effects / Audition onto the installed `.zxp`.

`.tools/` and `dist-packages/` are git-ignored. The old dev-load path still works: UXP via the
UXP Developer Tool, CEP via `npm run install-cc` (junction + PlayerDebugMode). Panel versions
are no longer hardcoded — `npm run panels:stamp` writes the server version into the six panel
version spots and `tool-counts`/panel-version tests fail on drift.
