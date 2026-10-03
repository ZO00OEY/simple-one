import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  ...obsidianmd.configs.recommended,
  { ignores: ["main.js", "node_modules/**"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: { process: "readonly", Buffer: "readonly", NodeJS: "readonly" }, parserOptions: { projectService: true } },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: ["GitHub", "Gitee", "Git", "README", "Simple Link", "Simple One", "Windows", "macOS", "Android", "iOS", "Linux", "Obsidian", "Markdown", "Things", "Callout", "Enter", "Esc", "Attachment", "Notes/Examples", "FindRegex", "ReplaceString"],
        acronyms: ["API", "HTTPS", "SSH", "CLI", "UTF", "ID", "HEX", "RGB", "RGBA", "HSL", "HSLA", "HTML", "URL", "JSON", "AI", "CSS"],
      }],
    },
  },
];
