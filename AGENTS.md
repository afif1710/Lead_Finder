# Lead Finder project instructions

- The authoritative project folder is `E:\Lead_Finder`. Run all project commands from this folder and keep future edits, artifacts, releases, and CSV work on E:. Do not recreate or write to the old Desktop folder on C:.
- Raw business exports belong in `E:\Lead_Finder\csv_exports`. Preserve raw CSVs when combining or cleaning leads; save processed outputs separately on E:.
- The user's prospects are businesses with no listed website or a confirmed broken, empty, or non-opening website. Exclude businesses with functioning websites. Flag blocked or uncertain URLs for review. Leave the extension's no-website-only checkbox off when collecting candidates that may have broken websites.
- The extension runs only on Google Maps, uses Manifest V3, bundles its phone library locally, and exports exactly six columns: business name, category, phone number, website, profession, city. No backend or analytics. The user authorized Git initialization and source pushes to https://github.com/afif1710/Lead_Finder.git for version tracking; exclude CSV exports, dependencies, test artifacts, and release packages.
- Keep Maps selectors centralized in `src/selectors.js`; preserve international phone formatting, branch-aware place-link deduplication, and downloadable stopped runs.
- The current extension deduplicates within each run only. Do not claim that separate CSVs are already merged or deduplicated across searches.
- Use the README and TESTING.md for existing setup and validation details. Rebuild the release ZIP after changes to shipped files.
