# 1.0.32 review repair — prepared for 1.0.33

Source: https://community.obsidian.md/account/plugins/simple-one, Nov 5 2026, commit ae5b194.

The scan reported three error groups: static style assignment in modules/ai/src/agent/view.ts:399; manual setting headings in modules/ai/src/api/settings.ts:323,332,340,348,357,437; and unsupported secretStorage APIs in modules/ai/src/main.ts:152,196,205,209,216.

The repair uses setCssStyles for textarea reset and shared Setting.setHeading for all six page titles. The plugin retains Obsidian 1.7.2 compatibility. The host already guards AI startup with requireApiVersion("1.11.4"); key read/write/delete now also put every SecretStorage access inside a positive requireApiVersion guard recognized by the official lint rule. Unsupported versions throw before App access; no plaintext key fallback is introduced and no API rule is disabled.

The module is now linted with type information. A detached checkout of ae5b194 and the repaired checkout were checked with identical final lint configuration: 17 errors / 421 warnings before, 0 errors / 421 warnings after. Warning fingerprints (file, rule, message) are unchanged. Existing AI rules that the community treats as warnings are explicitly warning severity locally; the AI lint command uses --quiet and fails on errors. Host src retains its existing --max-warnings 0 gate.

Validation after the compatibility and build changes: npm run lint passed. The complete npm test log reaches its final translation test with every suite reporting success, including 118 Agent checks and old-version SecretStorage rejection; no error/assertion failure appears. The terminal disconnected before its process exit status could be retrieved, so that exit code was not retained. The final strengthened reader build regression was then run separately with recorded exit code 0: two actual generated payloads agree, both Node zlib and the runtime fflate decoder return exactly the generated HTML and licenses. No real-vault reload or visual QA was performed. At the original validation checkpoint no release, push or branch review had been submitted, Version files are now prepared for 1.0.33; minAppVersion remains 1.7.2.

## Reproducible build repair

The original commit ae5b194 rebuilt on Windows / Node 22.23.1 / npm 10.9.8 / zlib 1.3.1-e00f703 matches the published/tag main.js byte-for-byte: 4,026,638 bytes, SHA-256 2357647fe54d9c21d1bc2e12716c9079fd9515bf7cc15a65ac489e4231e469ae. This rules out a mismatch between the committed artifact and this Windows rebuild, not every possible cause of the scanner warning.

The original embedded gzip header ends in OS byte 10 (Windows). System zlib is replaced by the existing exact fflate 0.8.3 dependency with mtime: 0; its platform-independent header ends in 3. The old and new decompressed JSON are identical (SHA-256 db951a72500c0bfca7419d23ab1cd2d7f3f62ba1df2d2d8179fb6a72235eba0e). The compression implementation also changes compressed bytes, rather than merely patching the OS header. This removes a verified platform-dependent input; it does not prove this was the scanner's only difference.

A clean build exposed another issue: TypeScript checked the generated readerPayload.ts before it existed. Production builds now generate the reader first, run TypeScript, then bundle the plugin. scripts/verify-build.mjs deletes derived outputs/payload before each of two builds and compares all six artifacts. Node 22.23.1 and npm 10.9.8 are declared in package metadata; .node-version pins Node, and the lockfile remains committed.

Two separate source directories each used npm ci --offline --ignore-scripts --no-audit --no-fund (495 packages) and each completed two clean builds. All four Windows builds and the working-copy rebuilds agree on all six artifacts. The final main.js is 4,091,547 bytes (under the 5,000,000-byte limit), SHA-256 e4f8f347467ea5beb4e9e110281101d16f58a4c0993177b2b3c21830ba49a0a8. styles.css SHA-256: e8fa921f436007ca04484dec430e9d13127aa0c77530a02c9b30fa3ce2dc0ec9. Full hashes are in .codex/output/build-hashes.json. These are Windows measurements only.

A workflow was prepared locally but, by the user’s explicit manual-publication choice, is excluded from the release commit and preserved in a local backup. Its unexecuted design included: clean Windows/Linux installation, lint/tests/repeat builds, cross-OS artifact comparison, and an optional manually requested provenance attestation job after comparison. No workflow has been uploaded or triggered, no attestation has been issued, and Linux byte equality has not been measured. Publication must use the exact verified artifacts; a new version must be chosen before releasing.

Evidence outside the repository in the task workspace: test-output-compat-final.txt, lint-final-all.txt, payload-test-final.txt and payload-test-final.exit.txt, build-verify-final.txt, clean-install-a.txt, clean-install-b.txt, clean-build-a-result.txt, clean-build-b-result.txt and baseline-artifact-analysis.json.

Remaining nonblocking scan findings include unsafe types, empty catch blocks, DOM helpers, popout globals, deprecated APIs, CSS compatibility/specificity, clipboard/vault capabilities, missing release artifact attestations (Recommendation), and build-output mismatch (Warning). Local build and CI preparation are described above; the community scan has not been rerun. Existing behavior/CSS/type warnings were not broadly rewritten as part of this focused error/build repair. npm audit was not executed after automatic approval rejected registry metadata disclosure, and was not retried.

# Automated review notes

The 1.0.15 scan confirmed the unsafe-type warnings were removed. Version 1.0.16 also upgrades fflate to 0.8.3 to address GHSA-px8p-9vwx-vf98 and adds production dependency auditing to release checks.

The following changes address the 1.0.14 community review:

- Production builds are minified, use gzip level 9, and ship only WOFF2 math fonts. A build fails if `main.js` exceeds 5,000,000 bytes. Mermaid, math and offline website publishing remain available.
- Desktop filesystem, crypto and command APIs have explicit structural contracts independent of the scanner's Node ambient declarations. Binary data uses `Uint8Array`; heading folding no longer depends on `Array.at`. All five unsafe-value ESLint rules are enforced locally.
- Reader CSS replaces `:has` with an explicit class, uses ordinary monospace fallbacks, and drops a redundant `text-indent` reset in plugin CSS.
- Share display preferences use Obsidian's workspace layout persistence. Navigator selection uses its API or the visible selected folder; the plugin no longer accesses browser local storage directly.

## Standalone website boundary

The website reader is maintained in `src/features/share/reader/default.html`, separate from plugin TypeScript. The build bundles its inline browser module and dependencies into a standalone `default.html`, including CSS and WOFF2 fonts, and writes `reader-licenses.txt` alongside it. The Release provides only the three standard plugin files. A gzip-compressed copy of the default HTML and licenses is bundled in main.js, so installation through the community-plugin market restores missing files offline. Existing HTML is preserved. The plugin reads the selected HTML from disk at publish time. Exported default HTML does not depend on reader JavaScript/CSS files or a CDN. It still reads public Markdown and catalog data from the website. The embedded script never executes in Obsidian. `document.createElement` and `fetch` are standard browser APIs here; `createEl` and `requestUrl` require Obsidian and cannot run on this website. Plugin network requests continue to use `requestUrl` or the explicitly configured desktop Git/GitHub CLI.

Existing custom templates using `reader/app.js` and `reader/app.css` remain supported; those compatibility assets are published alongside the HTML. Imported standalone templates preserve their own inline script and styles. Template import limits allow the embedded reader and fonts (16 MB). This runtime separation is not a claim that a new official scan has passed.

The reader fetches same-origin `catalog.json` and selected public Markdown files, sanitizes rendered content with DOMPurify, and runs Mermaid in strict security mode. These browser API warnings, if still emitted, require this runtime distinction rather than replacing them with unavailable APIs.

## Required capabilities

Vault enumeration is needed for attachment discovery, sync comparison and finding selected shared notes. Clipboard access supports explicit copy/paste actions. These capabilities remain intentional. GitHub sync requires an account and authorization; public sharing publishes selected content to a public repository. Web capture contacts the requested site. Desktop Git uses local filesystem and command APIs. There is no telemetry.

## 1.0.33 publication preparation

Remote main and latest release were checked before versioning: main ae5b194, latest 1.0.32, no 1.0.33 tag. The user explicitly requested publication. Version metadata and release notes are prepared for 1.0.33. Final 1.0.33 validation has explicit exit code 0 for lint and the complete npm test (including the real reader payload test). Two final clean builds are compared before publishing; The user selected manual publication without adding the workflow, so Windows/Linux CI is not run. The marketplace scan remains independent of GitHub release success.

The workflow-bearing unpublished commit 3338162 is preserved on local backup/1.0.33-with-workflow. The replacement release commit has parent ae5b194 and introduces no workflow in its pushed history. No existing remote workflow is removed or changed, and no workflow scope is requested. Standard plugin artifacts are unchanged by this metadata-only adjustment; local lint, complete tests and repeat builds retain their recorded exit 0 results.
