# Contributing

Report bugs through GitHub Issues with your Obsidian version, platform, theme,
and steps to reproduce. Never include private notes or plugin configuration.

For development, use Node.js 22, run `npm ci`, then `npm run check`.
AI settings import `Setting` and `ButtonComponent` from their local `ui.ts`, which forwards to `src/shared/settingControls.ts`. Use the host fieldset, native-checkbox and tooltip helpers; do not copy widget implementations or add a second description line. Regular dropdowns use Obsidian's DropdownComponent. Selection translation uses the shared AI catalogue and request service and must work with the AI interface disabled.
Keep changes focused and preserve desktop, mobile, and popout-window behavior.
Test changes in a disposable vault before using attachment operations.

Operation buttons use src/shared/actionButton.ts and the shared CSS tokens: 28px
on desktop, 44px on mobile, 6px radius and a 1px border (transparent for plain
toolbar actions). Text actions use styleActionButton(button, "text") and grow
only to fit their label; SVG actions remain square with a 16px icon. Preserve
CTA/danger colors. Pure icon setting rows use styleSettingIconAction so phone
settings do not stretch them across the row. Do not override action size tokens
in feature CSS.

Selection chips, tabs, numbered guide steps, calendar/date controls, file-tree
expanders, conflict side/merge choices, and the miniature text-formatting or
inline editing controls keep their specialized shapes. Color swatches, drag handles and eye/bell state controls retain their purpose-specific
geometry and selected colors. Navigation links and non-button decorative icons
are not operation buttons. New actions must opt in
to the shared helper; do not infer semantics from the presence of an SVG.
