# Simple One

Simple One brings note formatting, pasted-link processing, daily notes, calendars,
webpage capture, attachment organization, and display tools into one Obsidian plugin.
The settings interface is in Chinese. Desktop and mobile options are configurable separately.

## Installation

Open the [official plugin listing](https://community.obsidian.md/plugins/simple-one)
and choose **Add to Obsidian**, or search for **Simple One** in community plugins.
For manual installation, download `main.js`, `manifest.json`, and `styles.css` from
[Releases](https://github.com/ZO00OEY/simple-one/releases), place them in the
`simple-one` folder inside the `plugins` folder of your vault configuration directory,
and enable Simple One in Obsidian. Do not overwrite your existing `data.json`.

## Usage

Open **Settings → Simple One** to enable the tools you need. Use the note-header
actions for formatting and link copying, the diary view for daily notes and reminders,
and the capture view to turn a URL into a note. Configure output folders and website
rules before capturing content. Assign the two-column command shortcut yourself
in Obsidian hotkey settings; the plugin does not assign a default shortcut.

Attachment tools show a review list before applying changes and ask for confirmation.
Deletion follows the trash preference selected in **Files and links**.
The desktop window-position option keeps settings and community-plugin popout
windows inside the usable monitor area.

## Sync and sharing

Open **Settings → Simple One → 功能拓展 → 同步与分享** for the enable switch, bound repository, setup assistant, and desktop/mobile/server settings. On first load, existing Simple Link settings are copied without replacing its files or Simple One settings. Sync starts disabled; stop the old Simple Link sync before enabling this entry. If the old engine is running, transaction-state migration waits until it is stopped.

Native Git setup reviews ignore rules and tracked private files before synchronization resumes. The mobile plugin selector shares selected program files and shared settings, while forcibly excluding credentials, local state, caches, recovery files and their backups. Keep these private files when upgrading.

## Data and access

- Settings are saved locally through the Obsidian plugin data API.
- Attachment and diary tools enumerate and read vault files and may create or modify files.
- Link and capture tools access the clipboard and the websites requested by the user.
- The Notebook Navigator integration may read its selected-folder value from local storage.
- Base64 decoding is used to extract inline images into attachment files.
- No analytics service receives vault contents. Sync and sharing sends selected files to the GitHub repository or compatible server you configure.
- Desktop sync runs locally installed Git and, during guided GitHub authorization, GitHub CLI. Mobile sync uses GitHub API requests.
- Sync credentials and device state are stored locally in `sync-local.json`, `link-state.json` and recovery files; these and `data.json` are excluded from synchronization. `sync-settings.json` contains only whitelisted shared settings.

## Documentation

[Chinese usage guide](README.zh-CN.md) explains each tool and its settings.

## Features

| Tool | Purpose |
| --- | --- |
| Sync and sharing | Guided desktop Git, mobile GitHub API, and compatible server synchronization with privacy exclusions. |
| Text formatting | Apply headings, quotations and callouts to a line or selection. |
| Note cleanup | Run configurable formatting rules across a note, preserving URLs and frontmatter. |
| Pasted links | Fetch page titles, clean titles and convert Obsidian URLs to internal links. |
| Webpage capture | Extract configured fields and content into a note in the chosen folder. |
| Calendar and diary | Create daily notes, carry forward tasks and display reminders and holidays. |
| Attachments | Review unreferenced files, rename or relocate attachments and extract inline images. |
| Display tools | Adjust readable width and image height; preview colors, HTML and diagrams. |
| Desktop windows | Keep supported popout windows within the usable display area. |
| Search and properties | Filter search folders and populate new-note properties from a Base. |

Desktop and mobile display settings are stored separately. Some desktop features,
such as copying an absolute file path and repositioning native windows, are unavailable
on mobile. Website changes, login requirements and access restrictions can affect capture.
Some feature toggles require a plugin reload before taking effect.

## Feedback and license

Report issues through [GitHub Issues](https://github.com/ZO00OEY/simple-one/issues)
with the Obsidian version, operating system, theme and reproduction steps.
The plugin uses the [MIT License](LICENSE). Dependency notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
