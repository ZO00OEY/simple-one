# Simple One

English | [简体中文](README.zh-CN.md)

**Writing, organization, daily notes, sync, and public sharing in one configurable Obsidian toolkit.**

Format a note, capture a webpage, track daily tasks, or move notes between a computer and a phone. Enable the features you need. Desktop and mobile display settings can be saved separately. The settings interface is currently primarily in Chinese.

[Latest release](https://github.com/ZO00OEY/simple-one/releases/latest) · [User guide](USAGE.md) · [Changelog](RELEASE_NOTES.md) · [Report an issue](https://github.com/ZO00OEY/simple-one/issues)

## Features

| Workflow | Tools |
| --- | --- |
| Writing and cleanup | Heading, quote and Callout actions; configurable text formatting; pasted URL titles and link cleanup. |
| Webpage capture | Extract site fields into templates; create notes from a URL or supported site search; import, export and test rules. |
| Calendar and daily notes | Date navigation, templates, unfinished-task carryover, recurring events, anniversaries and yearly holiday schedules. |
| Reading and display | Text width, image size, columns, image zoom, and HTML, color and diagram previews. |
| Organization | New-note properties, search-folder filters, attachment scanning and cleanup. |
| Vault sync | Native desktop Git or lightweight GitHub API sync for phones and computers without Git; previews, conflict resolution and interrupted-download recovery. |
| Public sharing | Publish selected notes to a separate repository; stable links, public folders and names, HTML templates and optional EdgeOne hosting. |

Web capture depends on the target website, access restrictions and configured rules. Some rendered-page capture requires desktop capabilities. Published pages may look different from notes inside Obsidian.

## Install or update

1. Download **main.js, manifest.json and styles.css** from the same [Release](https://github.com/ZO00OEY/simple-one/releases).
2. Put the three files in `.obsidian/plugins/simple-one/` inside your vault. Substitute your configuration directory if customized.
3. Enable **Simple One** in Obsidian's community-plugin settings.

To update, replace these files and reload the plugin. Keep your existing configuration; do not delete the plugin directory. The default share reader and licenses are embedded, so no separate HTML download is required.

The base plugin requires **Obsidian 1.7.2**. Token-based sharing and EdgeOne authorization using Secret Storage require **1.11.4 or later**. Native desktop sync also requires Git. See the user guide for authorization details.

## Find the settings

Open **Settings → Simple One**:

- **Display / Theme**: reading and editing appearance.
- **Editing (编辑)**: header actions, editing options, paste handling and columns. Row-end gears open formatting, quick-note and display-replacement settings.
- **Extensions (拓展)**: enable the Sync, Sharing and Schedule tabs; configure search-folder filters and attachment tools.
- **Schedule (日程)**: daily notes, calendars, recurring events, anniversaries and yearly holidays.
- **Sync (同步) / Sharing (分享)**: separate tabs for private vault sync and public note publishing.

Start with the features you need. Many concise settings expose extra explanations on hover.

## Choose a sync method

| Method | Devices | Purpose |
| --- | --- | --- |
| Desktop Git | Computers with Git | A local Git repository, history, automatic backups and remote updates. |
| Lightweight Git sync | Android, iOS and desktop | GitHub API access without local Git; file previews, sync scope and download recovery. |
| Public sharing | Desktop and mobile | Publish selected notes for readers; configured separately from private vault sync. |

Choose one vault sync method per device. Avoid multiple tools writing to the same vault concurrently. Review first-sync, deletion and conflict previews. Keep an independent backup before sync setup or bulk attachment operations.

Desktop Git sync obtains credentials through GitHub CLI. If you switch between multiple GitHub accounts, grant each account the required read and write access to the same sync repository; otherwise, changing the active CLI account may prevent pulls or pushes. You do not need to sign in before every sync, but signing out or invalid credentials requires authorization again. This advice concerns vault sync. Lightweight Git sync uses its separately configured token, which must have sufficient access to the sync repository.

## Access and privacy

- **No telemetry.** Web capture contacts the requested site. GitHub sync and sharing contact their configured services. EdgeOne is optional.
- **Sync requires authorization.** Credentials and runtime state are local data. Do not commit them to public repositories or attach full configuration files to issues.
- **Shared means public.** Selected notes and referenced attachments become accessible. Withdrawing a note does not erase Git history, caches or other people's copies. Body text and ordinary external links are not automatically anonymized: review them before publishing.
- **Local tools need file access.** Sync, diary and attachment tools read or write vault files; copy actions use the clipboard; desktop Git runs local commands.
- **Source and vault repositories differ.** This standalone plugin repository excludes personal settings, credentials, logs, runtime state, share records and custom templates. A private vault's settings-sync policy is separate; do not copy source-repository exclusions blindly into vault sync rules.

See the [user guide](USAGE.md), [personal files and credentials](docs/private-files.md) and [technical review notes](docs/automated-review-notes.md).

## In 1.0.25

This release is the verified release baseline for the settings, attachment and reader improvements introduced in 1.0.24. Shared settings groups, checkbox icons and buttons keep the interface consistent. Attachment operations share selection and move workflows. The plugin and default sharing reader share canvas mode, drag-to-pan, mouse-anchored wheel zoom, fit and fullscreen. Published columns retain saved proportions and stack on narrow screens; editing gestures remain in Obsidian.

The settings interface remains primarily Chinese; English and Chinese documentation are maintained together. Existing websites need another publish using the updated default reader to receive the new controls. Keep personal settings and custom templates when upgrading.

See the [release notes](RELEASE_NOTES.md) and [review record](docs/release-review-1.0.25.md) for scope and limitations. Not every website rule, device or third-party theme combination has been validated.

## Development and feedback

Use Node.js 22:

```sh
npm ci
npm run check
```

Use `npm run dev` for watch builds and `npm run build` for release output. Builds enforce strict TypeScript and unused-code checks. The full check includes production dependency auditing, ESLint/CSS checks and regression tests.

Installation in a standalone Git checkout creates missing local ignore rules and preserves existing rules. See [CONTRIBUTING.md](CONTRIBUTING.md).

Include reproduction steps, platform and Obsidian version in [Issues](https://github.com/ZO00OEY/simple-one/issues). Use sanitized examples rather than private notes or credentials.

[MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
