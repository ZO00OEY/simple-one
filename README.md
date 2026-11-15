# Simple One

English | [简体中文](README.zh-CN.md)

Simple One is a configurable Obsidian toolkit for vault sync, web publishing, schedules, AI, editing, attachments, display and theme settings. Enable the parts you need. The settings interface is currently primarily in Chinese.

[Latest release](https://github.com/ZO00OEY/simple-one/releases/latest) · [User guide](USAGE.md) · [Changelog](RELEASE_NOTES.md) · [Report an issue](https://github.com/ZO00OEY/simple-one/issues)

## At a glance

| Area | What it does |
| --- | --- |
| Sync | Sync a vault with native Git on desktop, or use GitHub API sync on phones and computers without Git. Includes change previews, conflict handling and download recovery. |
| Sharing | Publish selected notes and attachments as HTML pages with readable links, using a separate GitHub repository, GitHub Pages and optional EdgeOne hosting. |
| Schedule | Manage calendars, daily notes, unfinished tasks, recurring reminders, anniversaries and yearly holiday schedules. |
| AI | Use chat, model management, note tools, skills and model cooperation, with optional working memory and capability assessment. |
| Extensions | Enable feature tabs and use search-folder filters, webpage capture, quick note creation, attachment naming, storage, reference lookup and cleanup. |
| Editing | Use a floating toolbar, colored formatting, selection translation, text cleanup, pasted-link handling and side-by-side editing. |
| Display | Configure desktop and mobile separately, with better HTML previews, image interaction, diagrams and color-code previews. |
| Theme | Adjust accent colors, body and heading fonts, sizes, colors and spacing, plus quote and Callout appearance. |

## Main features

### Sync: use your vault across computers and phones

- **Native desktop Git:** save commits, check remote changes, merge and push, with automatic sync and conflict handling. Requires Git and authorization through GitHub CLI.
- **Lightweight sync:** use the GitHub API without local Git on Android, iOS or desktop. Preview file differences, review scope, resolve deletions and conflicts, and resume interrupted downloads.
- **Sync sidebar:** inspect status and changes in a list or folder tree. Large lists are paginated; long error details show up to ten lines until expanded.

Choose a sync method for each device. Review scope and changes before the first sync, avoid concurrent sync tools writing to the same vault, and keep an independent backup of important notes.

### Sharing: give someone a link they can read

Add selected notes to a sharing list, publish to a separate GitHub repository, and let readers open them in a browser without Obsidian.

- Publish notes and referenced attachments with public names, folders and stable links.
- Use GitHub Pages or optionally link an EdgeOne project. The sidebar provides publishing, refresh, deployment status, logs, link copying and website actions.
- Use the built-in HTML reader with file navigation, a table of contents, light/dark modes, colors and typography controls, or supply a custom HTML template.
- Configure sharing separately from private vault sync and manage multiple sharing libraries.

Published content is public. Review notes and attachments before publishing. Withdrawing a note does not erase Git history, caches or saved copies. Web pages may differ from your Obsidian theme and plugin rendering.

### Schedule: daily notes, tasks and reminders together

Browse dates, open or create daily notes, configure their folder and template, and carry unfinished tasks forward. Manage recurring items, anniversaries, same-day or advance reminders, and yearly holidays and adjusted working days.

### AI: chat and work with your notes

Built-in AI chat and model settings need no separate AI plugin. Manage providers, models, assistants and usage in one place, and work with note context, tools, skills and model cooperation.

Optional working memory supports source inspection, editing, forgetting and undo. Capability assessment records model performance to help choose cooperating models; applying configuration recommendations still requires user confirmation. Both features are off by default.

Toolbar translation shares the same model catalogue, with its own model, language and prompt choices. Manual translation remains available with the AI chat interface disabled. AI and translation send the relevant text and context to your configured provider.

### Extensions: search, capture and attachment organization

- **Feature entry points:** enable Sync, Sharing, Schedule and AI as needed.
- **Search:** exclude folders and search the vault or web from selected text.
- **Quick note creation:** extract titles, authors, body text and other site fields into templates. Supports URL capture, search on supported sites, and rule import, export and testing.
- **Attachments:** inspect storage settings, organize image and attachment names and folders, extract embedded images, find referring notes, and scan or clean unused files. Some operations can run automatically.
- **Note utilities:** fill new-note properties, rename tags, and quickly copy note links or paths.

Web capture depends on site structure, access restrictions and rules; some rendered-page capture requires desktop capabilities. Review attachment lists before bulk actions. Automatic cleanup is off by default and checks references and stability before acting.

### Editing: keep everyday tools close

- **Floating toolbar:** format selected text with multiple styles and colors, search, translate, and customize button visibility and order. It serves as an editing toolbox for daily writing.
- **Headings, quotes and Callouts:** apply or convert formats with custom colors and styles.
- **Translation preview:** compare source and translation by paragraph, then insert ordinary text or translation cards. Cards support editing, regeneration and conversion to text.
- **Text and paste cleanup:** apply rules for whitespace, line breaks and numbering; fetch and clean titles for pasted URLs and convert ordinary or Obsidian links.
- **Columns:** arrange and edit content side by side, with context-menu, gesture and keyboard entry points, and up to four columns.

### Display: adapt to screens and content

- Save desktop and mobile display settings separately, including note width, image height and popout scale. Mobile also has header-button and compact-bottom-bar options.
- **On desktop**, optionally collapse the right sidebar when the writing area becomes too narrow; it can still be reopened manually. This option is not duplicated on mobile.
- Preview HTML code blocks without executing embedded scripts. Apply display-only text replacement rules without changing the source.
- Open and zoom images; fit, pan, zoom or view Mermaid diagrams full screen; preview color codes in the editor.

### Theme: adjust note appearance in one place

Set the theme accent color and configure fonts, sizes, colors, line height, letter spacing and paragraph spacing for body text, headings and supported formats. Customize quote and Callout appearance, including custom Callouts. Enable individual overrides as needed; disabled options follow Obsidian or the current theme.

## Install or update

1. Download **main.js, manifest.json and styles.css** from the same [Release](https://github.com/ZO00OEY/simple-one/releases/latest).
2. Put them in `.obsidian/plugins/simple-one/` inside your vault, substituting your configuration directory if customized.
3. Enable **Simple One** in community-plugin settings, then open **Settings → Simple One** to choose features.

To update, replace those three files and reload the plugin. Preserve personal settings and custom templates; do not delete the plugin directory. The default sharing reader is embedded, so no separate HTML download is needed.

| Environment | Requirements |
| --- | --- |
| Base features | Obsidian 1.7.2 or later; desktop and mobile support, with platform-specific limitations. |
| Built-in AI, translation and sharing authorization through Secret Storage | Obsidian 1.11.4 or later and the relevant service configuration. |
| Native Git sync | Desktop, Git and GitHub CLI authorization. |
| GitHub API sync | A GitHub repository and a token with the required permissions; no local Git. |

## Data and access

The plugin has no telemetry. Web capture contacts the target website; sync, sharing and AI contact your configured services. Local diary, editing and attachment tools read or write vault files, copy actions use the clipboard, and desktop Git runs local commands.

Personal settings, credentials, chats, sync state, logs and private sharing records are excluded from public source and Release assets. Source-repository exclusions serve a different purpose from private-vault sync rules. See [personal files and credentials](docs/private-files.md).

## Development and feedback

Use Node.js 22; the pinned version is in `.node-version`:

```sh
npm ci
npm run check
```

`npm run dev` watches for changes, `npm run build` creates release files, and `npm run build:verify` checks clean rebuild reproducibility. See [CONTRIBUTING.md](CONTRIBUTING.md).

Include your platform, Obsidian version, theme and reproduction steps when reporting an issue, using sanitized examples. Automated tests do not replace verification on every phone, theme or live service.

[MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
