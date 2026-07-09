# LexAnon

Chrome extension for anonymizing personal data in `.docx` documents — the
thin client for the on-premises **LexAnon Server**. Documents are processed
entirely on your firm's own server and never leave your network.

---

## How it works

1. Your administrator runs the LexAnon Server (a single binary) on any
   machine inside your network.
2. You pair this extension with the server once, using a one-time pairing
   code from the administrator.
3. **Anonymize:** upload a `.docx` → the server detects personal data
   (pattern rules + a locally hosted LLM) → review every entity → download
   the anonymized document with consistent placeholders like `[NAME_1]`.
4. Send the anonymized document to any external AI tool.
5. **Restore:** upload the document that comes back → the server matches it
   to its job automatically → review every substitution (including fuzzy
   matches where the AI tool mangled a placeholder) → download the restored
   original.

The placeholder→original mapping is stored encrypted on the server and is
never exported. Nothing is ever restored without explicit human review.

## Upload intercept on AI chat sites

On known AI chat sites (ChatGPT, Claude, Gemini, Copilot, Perplexity, Poe,
DeepSeek, Grok, Mistral, HuggingChat, Meta AI, You.com, Qwen, Kimi — and
nowhere else), attaching a `.docx`/`.txt`/`.pdf`/`.doc` — via the file
picker **or drag & drop** — pauses the upload and asks whether to
anonymize it first. One click runs the full server
pipeline and swaps the anonymized file into the upload; the verification
result (a second AI pass over the output) is shown right in the panel.

- Uploading the original is always an explicit, labeled choice — closing
  the panel attaches nothing, and if the LexAnon server is unreachable the
  panel says loudly that the file was **not** anonymized instead of letting
  it through.
- The panel includes a free-text box — *"Anything specific you want to
  redact?"* — passed to the server's LLM detection pass (e.g. project
  codenames, rates, settlement amounts). The same box exists on the
  full-page anonymize view; the value is remembered.
- The intercept can be turned off from the toolbar popup.

## Detected data

Persons, companies, addresses, emails, phone numbers, SSNs, tax IDs / EINs,
IBANs (with checksum validation), SWIFT codes, URLs, contract numbers and
monetary amounts — plus names the server's LLM finds that pattern rules
miss.

## Failure honesty

If the server's AI detection layer is disabled, fails, or partially fails,
the extension says so prominently. Rules-only results are never passed off
as full analysis.

## Installation

From the Chrome Web Store (soon), or unpacked:

1. Clone this repository
2. Open `chrome://extensions/`, enable **Developer mode**
3. **Load unpacked** → select the repository folder
4. Click the LexAnon toolbar icon and pair with your server

## Project structure

```
├── manifest.json      # MV3, storage permission only; host access is
│                      # requested per-server at pairing time; content
│                      # script limited to an allowlist of AI chat sites
├── lib/api.js         # server client (pairing, jobs, restore)
├── background.js      # service worker: proxies the intercept flow's server
│                      # calls (content scripts are subject to page CORS)
├── content/           # upload intercept on allowlisted AI chat sites
├── popup/             # toolbar popup: status, pairing, intercept toggle
├── app/               # full-page workflow: anonymize + restore review
└── icons/
```

## Server

The server component lives in a separate repository. It is a single static
binary (macOS / Windows / Linux) with an admin page for pairing codes and
job management.

## License

MIT — see [LICENSE](LICENSE)
