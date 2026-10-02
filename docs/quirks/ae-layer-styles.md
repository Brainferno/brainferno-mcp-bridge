# After Effects layer styles (scripting)

Relevant to `ae_add_layer_style` and friends.

After Effects layer styles (drop shadow, stroke, glows…) cannot be added with
`addProperty` — AE refuses it. The only working way is the **Layer > Layer Styles
menu command**: comp open in the viewer (`comp.openInViewer()`), only the target
layer selected, then `app.executeCommand(id)`. The ids are the stable 9000–9008
block: dropShadow 9000, innerShadow 9001, outerGlow 9002, innerGlow 9003,
bevelEmboss 9004, satin 9005, colorOverlay 9006, gradientOverlay 9007, stroke
9008. `findMenuCommandId("Drop Shadow")` also returns these but returned a bogus
value once right after a panel reconnect, so use the fixed id first and the label
only as a retry.

Under `layer.property("ADBE Layer Styles")` all 11 style slots always exist but
are hidden until added. Address a style's group by its **match name
`"<key>/enabled"`** (e.g. `"solidFill/enabled"` for Color Overlay) or by display
name — the bare key returns null for every style except `dropShadow`. Internal
keys: satin=`chromeFX`, colorOverlay=`solidFill`, gradientOverlay=`gradientFill`,
stroke=`frameFX`; the rest match their name. `canSetEnabled` is false until the
style is added, so it doubles as "is this style present". `.remove()` on a style
group throws ("Object of type Error found where a Number…"); AE keeps the slot
forever, so the only real "remove" is `group.enabled = false` (the eyeball off).

This was found by live-probing AE via a temporary rig: kill the MCP server, run a
throwaway node script that spawns `dist/index.js` with
`BRAINFERNO_MCP_ALLOW_RAW_SCRIPTS=1` and forwards dropped `.jsx` files to
`cc_eval_script(appId:"after_effects")`. Panels auto-reconnect when the bridge
returns on the same port 7897, so no manual Connect is needed. See the reload/release
routine in `docs/HANDOFF.md`.
