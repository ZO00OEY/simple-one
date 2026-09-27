# Simple Plugin

Format notes, manage diaries and attachments, and streamline links in Obsidian.

## Features

- Format the current note, use quick formatting controls, and process pasted URLs and Obsidian links.
- Create daily notes with recurring tasks, anniversaries, holiday schedules, and reminders.
- Preview colors and HTML, enhance Mermaid diagrams, zoom images, and work with Notion-style columns.
- Create notes from supported websites and configurable extraction rules.
- Review attachment cleanup and organization plans before applying changes.

Most features can be enabled or configured independently in **Settings → Simple Plugin**. The diary follows the vault's core Daily notes folder, date format, and template on first load when those settings are available. Website presets initially save notes at the vault root until an output folder is chosen.

## Privacy and network access

Plugin settings are stored locally in `.obsidian/plugins/simple-plugin/data.json`. This file is ignored by Git and must not be included in releases. The plugin has no analytics or client-side telemetry.

URL title lookup and website-to-note features make network requests only when used. They may contact a URL supplied by the user or a selected preset site, including Jinjiang, 52shuku, Fanqie, Qidian, and Agent Skills. Some desktop extraction fallbacks open the selected website in a hidden webview; the Fanqie search fallback may use that site's cookies for a request to its own API. No plugin-operated server receives vault content.

The plugin reads and writes notes and attachments within the current vault for its editing, diary, and attachment features. Attachment cleanup shows a review list before moving selected files to the Obsidian trash. Features that cannot safely distinguish attachments from other files are disabled when the vault's attachment setting points to its root.

## Install manually

Copy `main.js`, `manifest.json`, and `styles.css` from a matching [release](https://github.com/ZO00OEY/simple-plugin/releases) into `.obsidian/plugins/simple-plugin/`, then enable **Simple Plugin** in Obsidian's Community plugins settings.

## Build from source

```sh
npm ci
npm run build
```

The repository includes source code and the bundled release files. Do not commit `data.json`, vault notes, or Obsidian workspace settings.

## License

MIT. See [LICENSE](LICENSE) and [third-party license notices](THIRD_PARTY_NOTICES.md).
