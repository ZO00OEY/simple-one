# Automated review notes

The 1.0.15 scan confirmed the unsafe-type warnings were removed. Version 1.0.16 also upgrades fflate to 0.8.3 to address GHSA-px8p-9vwx-vf98 and adds production dependency auditing to release checks.

The following changes address the 1.0.14 community review:

- Production builds are minified, use gzip level 9, and ship only WOFF2 math fonts. A build fails if `main.js` exceeds 5,000,000 bytes. Mermaid, math and offline website publishing remain available.
- Desktop filesystem, crypto and command APIs have explicit structural contracts independent of the scanner's Node ambient declarations. Binary data uses `Uint8Array`; heading folding no longer depends on `Array.at`. All five unsafe-value ESLint rules are enforced locally.
- Reader CSS replaces `:has` with an explicit class, uses ordinary monospace fallbacks, and drops a redundant `text-indent` reset in plugin CSS.
- Share display preferences use Obsidian's workspace layout persistence. Navigator selection uses its API or the visible selected folder; the plugin no longer accesses browser local storage directly.

## Standalone website boundary

The website reader is maintained in `src/features/share/reader/default.html`, separate from plugin TypeScript. The build bundles its inline browser module and dependencies into a standalone `default.html`, including CSS and WOFF2 fonts, and writes `reader-licenses.txt` alongside it. These files ship as release assets. A gzip-compressed copy of the default HTML and licenses is bundled in main.js, so installation through the community-plugin market restores missing files offline. Existing HTML is preserved. The plugin reads the selected HTML from disk at publish time. Exported default HTML does not depend on reader JavaScript/CSS files or a CDN. It still reads public Markdown and catalog data from the website. The embedded script never executes in Obsidian. `document.createElement` and `fetch` are standard browser APIs here; `createEl` and `requestUrl` require Obsidian and cannot run on this website. Plugin network requests continue to use `requestUrl` or the explicitly configured desktop Git/GitHub CLI.

Existing custom templates using `reader/app.js` and `reader/app.css` remain supported; those compatibility assets are published alongside the HTML. Imported standalone templates preserve their own inline script and styles. Template import limits allow the embedded reader and fonts (16 MB). This runtime separation is not a claim that a new official scan has passed.

The reader fetches same-origin `catalog.json` and selected public Markdown files, sanitizes rendered content with DOMPurify, and runs Mermaid in strict security mode. These browser API warnings, if still emitted, require this runtime distinction rather than replacing them with unavailable APIs.

## Required capabilities

Vault enumeration is needed for attachment discovery, sync comparison and finding selected shared notes. Clipboard access supports explicit copy/paste actions. These capabilities remain intentional. GitHub sync requires an account and authorization; public sharing publishes selected content to a public repository. Web capture contacts the requested site. Desktop Git uses local filesystem and command APIs. There is no telemetry.
