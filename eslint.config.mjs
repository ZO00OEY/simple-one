import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  ...obsidianmd.configs.recommended,
  { ignores: ["main.js", "node_modules/**"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: ["Obsidian", "Markdown", "Things", "Callout", "Enter", "Esc", "Attachment", "Notes/Examples", "FindRegex", "ReplaceString"],
        acronyms: ["HEX", "RGB", "RGBA", "HSL", "HSLA", "HTML", "URL", "JSON", "AI", "CSS"],
      }],
    },
  },
];
