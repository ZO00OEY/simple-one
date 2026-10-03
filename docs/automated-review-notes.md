# Automated review notes

The following changes address the 1.0.14 community review:

- Production builds are minified, use gzip level 9, and ship only WOFF2 math fonts. A build fails if `main.js` exceeds 5,000,000 bytes. Mermaid, math and offline website publishing remain available.
- Desktop filesystem, crypto and command APIs have explicit structural contracts independent of the scanner's Node ambient declarations. Binary data uses `Uint8Array`; heading folding no longer depends on `Array.at`. All five unsafe-value ESLint rules are enforced locally.
- Reader CSS replaces `:has` with an explicit class, uses ordinary monospace fallbacks, and drops a redundant `text-indent` reset in plugin CSS.
- Share display preferences use Obsidian's workspace layout persistence. Navigator selection uses its API or the visible selected folder; the plugin no longer accesses browser local storage directly.

## Standalone website boundary

`src/features/share/reader/app.ts` executes only on the exported GitHub Pages website. The build bundles it separately and embeds its compressed files as publishing assets; it is never imported into the Obsidian runtime. `document.createElement` and `fetch` are therefore standard browser APIs here. `createEl` and `requestUrl` require Obsidian and cannot run on this website. Plugin network requests continue to use `requestUrl` or the explicitly configured desktop Git/GitHub CLI.

The reader fetches same-origin `catalog.json` and selected public Markdown files, sanitizes rendered content with DOMPurify, and runs Mermaid in strict security mode. These browser API warnings, if still emitted, require this runtime distinction rather than replacing them with unavailable APIs.

## Required capabilities

Vault enumeration is needed for attachment discovery, sync comparison and finding selected shared notes. Clipboard access supports explicit copy/paste actions. These capabilities remain intentional. GitHub sync requires an account and authorization; public sharing publishes selected content to a public repository. Web capture contacts the requested site. Desktop Git uses local filesystem and command APIs. There is no telemetry.
