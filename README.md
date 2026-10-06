# Maps Lead Finder

A personal Manifest V3 extension for Microsoft Edge and Google Chrome that exports Google Maps search results to CSV. Processing happens locally in the browser, with no backend or analytics.

## Features

- Collects listings while scrolling, with deduplication within each scan.
- Reads business names, categories, phone numbers, and listed websites.
- Opens individual profiles when compact cards hide contact details.
- Formats phone numbers with a bundled library and optional country code.
- Supports partial exports and an optional filter for businesses without a listed website.

## Installation

1. Clone or download this repository into a permanent folder.
2. Open `edge://extensions` or `chrome://extensions`.
3. Enable **Developer mode** and click **Load unpacked**.
4. Select the folder containing `manifest.json`.
5. Open or refresh [Google Maps](https://www.google.com/maps).

No build step or Node.js installation is required to load the extension.

## Usage

1. Search in Google Maps, for example `restaurants in City Centre, Belfast, UK`.
2. Check **Profession** and **City** in the extension; these label the export.
3. Leave **Country code** blank for automatic detection, or enter a code such as `+44`.
4. Choose the website filter, click **Start**, and keep the tab open.
5. Click **Download CSV** when finished. **Stop** preserves partial results.

The CSV contains six columns: `business name`, `category`, `phone number`, `website`, `profession`, and `city`. It uses UTF-8 and spreadsheet formula protection. Import phone numbers as **Text** in Excel.

## Limitations

- Coverage depends on the results Google Maps exposes; counts can vary.
- Compact listings require profile checks and take longer. Unreadable details produce warnings.
- Website functionality is not verified. Uncertain website status is excluded from the no-website filter.
- The filter applies when a scan starts. Separate exports are not automatically merged.
- Closing or refreshing Maps clears in-memory results; download first.
- Layout changes may require selector updates. Supported domains are listed in `manifest.json`.

## Development

With Node.js and npm installed:

```sh
npm ci
npm run check
npm test
npm run test:browser
```

Browser integration tests use an isolated Edge profile by default. See [TESTING.md](TESTING.md) for validation details.

```sh
npm run vendor   # Regenerate bundled assets
npm run package  # Create a release ZIP using PowerShell
```

After changes, reload the extension on the browser's extensions page and refresh Maps. Regenerate assets after editing `styles/panel.css` or the bundled library.

## Project structure

```text
manifest.json  Extension configuration
src/           Extraction, UI, scan controls, phone formatting, and CSV export
styles/        Panel styling and generated stylesheet module
vendor/        Bundled phone library, license, and provenance
tests/         Unit and browser integration tests
scripts/       Validation, asset generation, and packaging
```

Dependencies, CSV exports, test artifacts, and generated releases are excluded from Git. Third-party licensing information is included in `vendor/`.
