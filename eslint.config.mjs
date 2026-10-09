import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  ...obsidianmd.configs.recommended,
  { ignores: ["main.js", "node_modules/**"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: { process: "readonly", Buffer: "readonly", NodeJS: "readonly" }, parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: ["GitHub", "GitHub Pages", "Page One", "EdgeOne", "EdgeOne Pages", "Makers", "API Token", "Gitee", "Git", "README", "Simple Link", "Simple One", "Windows", "macOS", "Android", "iOS", "Linux", "Obsidian", "Markdown", "Things", "Callout", "Enter", "Esc", "Attachment", "Notes/Examples", "FindRegex", "ReplaceString"],
        acronyms: ["API", "HTTPS", "SSH", "CLI", "UTF", "ID", "HEX", "RGB", "RGBA", "HSL", "HSLA", "HTML", "URL", "JSON", "AI", "CSS", "ZIP"],
      }],
    },
  },
];
