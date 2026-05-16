# Copilot Chat Exporter

A Microsoft Edge extension that exports full M365 Copilot conversations — including generated images, citations, and rich formatting — to **Markdown**, **JSON**, **Plain text**, **PDF**, and **DOCX**.

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)
![Manifest V3](https://img.shields.io/badge/manifest-v3-brightgreen.svg)

---

## Features

- **Complete chat capture** — scrolls through the full conversation history, including lazy-loaded messages, so nothing is missed
- **Rich formatting** — bold, italic, inline code, code blocks, headings, lists, tables, blockquotes, and hyperlinks are preserved in both DOCX and PDF output
- **Inline images** — AI-generated images (Microsoft Designer) appear in the correct position within the conversation, not appended at the end
- **Citations / Sources** — web references are exported as hyperlinks
- **Five export formats**
  | Format | Notes |
  |--------|-------|
  | Markdown | GitHub-flavoured, with image links |
  | JSON | Structured data including segments, images, citations |
  | Plain text | Clean readable transcript |
  | PDF | Full-page print preview with inline images |
  | DOCX | Word document with styles, inline images, hyperlinked citations |

---

## Supported pages

- `copilot.microsoft.com`
- `m365.cloud.microsoft`
- `www.microsoft365.com`
- `*.sharepoint.com`
- `teams.microsoft.com`
- `outlook.office.com` / `outlook.office365.com`

---

## Installation (developer / sideload)

> The extension is not yet listed in the Edge Add-ons store. Install it manually in a few steps.

1. **Download or clone this repository**

   ```bash
   git clone https://github.com/YOUR_USERNAME/copilot-chat-exporter.git
   ```

2. **Open Edge extensions**

   Navigate to `edge://extensions/` in Microsoft Edge.

3. **Enable Developer mode**

   Toggle **Developer mode** on (top-right corner).

4. **Load the extension**

   Click **Load unpacked** and select the cloned folder.

5. **Use it**

   Navigate to a Copilot chat, click the extension icon in the toolbar, choose a format, and click **Export chat**.

---

## Usage

1. Open any conversation at [copilot.microsoft.com](https://copilot.microsoft.com) or inside M365.
2. Click the **Copilot Chat Exporter** icon in the Edge toolbar.
3. Select your desired format.
4. Click **Export chat** — the extension scrolls through the full history automatically, then downloads the file (or opens a print preview for PDF).

---

## How it works

| Step | What happens |
|------|-------------|
| 1 | Finds the chat scroll container by walking up from a known message element |
| 2 | Scrolls up incrementally to trigger lazy-loaded history, waits for DOM to settle |
| 3 | Scrolls back down, accumulating every message as it enters the DOM |
| 4 | Runs the extractor on the final merged message cache |
| 5 | Builds the chosen format and downloads it |

Image data is fetched via the background service worker (which has access to Microsoft auth cookies) so generated images are embedded correctly in DOCX and PDF exports.

DOCX files are built entirely in-browser — no server, no npm, no build step — using a pure-JavaScript ZIP + Open XML generator.

---

## Permissions

| Permission | Why |
|-----------|-----|
| `activeTab` | Read the current Copilot tab |
| `scripting` | Inject the extractor into the page |
| `downloads` | Save the exported file |
| `storage` | Pass the HTML blob to the print preview page; store approved-domain settings |
| Host permissions | Fetch auth-cookie-gated images from approved Microsoft domains |

---

## Project structure

```
├── manifest.json        Extension manifest (MV3)
├── popup.html           Extension popup UI
├── popup.css            Popup styles
├── popup.js             Export orchestration (scroll, accumulate, download)
├── extractor.js         Injected into the page — reads DOM / React fibers
├── docx-builder.js      Pure-browser DOCX / ZIP / Open XML generator
├── background.js        Service worker — file downloads, image fetching
├── print.html           Full-screen PDF preview page
├── print.js             Loads HTML from session storage into the preview
├── content.js           Minimal content script placeholder
└── icons/               Extension icons (16, 32, 48, 128 px)
```

---

## Contributing

Pull requests are welcome. For significant changes please open an issue first to discuss what you'd like to change.

---

## Disclaimer

This extension is an independent open-source project and is not affiliated with, endorsed by, or connected to Microsoft Corporation. "Copilot" and "Microsoft 365" are trademarks of Microsoft Corporation.

---

## License

[MIT](LICENSE)
