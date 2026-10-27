# Anna's Archive for Zotero

A Zotero plugin that downloads PDFs for library items with a DOI via [Anna's Archive SciDB](https://annas-archive.gl/scidb).

Compatible with **Zotero 7–10**.

This project is a Zotero 7+/10 rewrite of the legacy [zotero-scihub](https://github.com/ethanwillis/zotero-scihub) overlay plugin, adapted for Anna's Archive SciDB. Mirrors are discovered automatically and tried in order when one is down.

## Install

1. Download the latest `.xpi` from the [Releases](https://github.com/janbaykara/zotero-annas-archive/releases) page  
   (in Firefox, right-click → Save As).
2. In Zotero: **Tools → Plugins**.
3. Gear icon → **Install Plugin From File…** and choose the `.xpi`.
4. Restart Zotero if prompted.

## Usage

- Right-click item(s) → **Find Full Text** (Zotero’s built-in action; SciDB is tried after publisher and open-access sources)
- Right-click item(s) → **Download PDF from Anna's Archive**
- Right-click a collection → **Download PDFs for Collection**
- **Tools → Update All PDFs from Anna's Archive**

New items with a DOI are downloaded automatically when that option is enabled in settings. The same option opts SciDB into Zotero’s own automatic PDF download.

## Settings

Open **Zotero → Settings → Anna's Archive**:

- **Preferred SciDB endpoint** — default `https://annas-archive.gl/scidb/` (tried first)
- **Backup mirrors** — editable list tried in order after the preferred endpoint
- **Also auto-discover extra mirrors online** — appends newly found mirrors after your list
- **Automatically download PDFs for new items** — also used by Zotero’s native auto-PDF / Find Full Text resolvers
- **Membership secret key** — from your [Anna’s Archive account](https://annas-archive.gl/account). Uses the official `/dyn/api/fast_download.json` API (DOI → MD5 → direct URL) and skips the public bot-check. Quota is your membership’s fast downloads per 24 hours.

Find Full Text runs Zotero’s publisher and open-access lookup first. If no PDF is found and a membership key is set, the plugin uses member fast downloads; otherwise it falls back to SciDB page scraping (DDoS-Guard may still apply).

## Development

Requires Node.js 20+.

```bash
npm install
npm start          # build + hot-reload against a local Zotero
npm run build      # production XPI in .scaffold/build/
```

## Disclaimer

Use this software in accordance with the laws of your jurisdiction. No warranties are provided.
