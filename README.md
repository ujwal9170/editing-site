# Frame / Editing Site

A modular Instagram, YouTube and TikTok video workspace: import a clip and caption, keep it in Media, edit it, and save a Reel-format MP4 plus its post caption in Edited Videos.

**Status: runnable development version.** The website and worker are implemented. This is a shared workspace for a small team; separate user accounts and production cloud services are still planned. AI caption generation is intentionally deferred.

## Run locally

Requires Node.js **24+**, pnpm **10**, and Python **3.11+**. No separate FFmpeg installation is needed: `imageio-ffmpeg` supplies the executable.

```sh
pnpm install --frozen-lockfile
python -m venv .venv
```

On Windows:

```powershell
.venv\Scripts\python.exe -m pip install -r worker/requirements.txt
pnpm setup:audio
pnpm dev
```

On macOS/Linux:

```sh
.venv/bin/python -m pip install -r worker/requirements.txt
pnpm setup:audio
pnpm dev
```

Open **http://127.0.0.1:4174**. The launcher automatically uses the project virtual environment. The Fastify API runs on loopback port 4175 and is proxied through Next.js.

`setup:audio` downloads the requested Kim Vocal 2 model, checks its SHA-256, and copies the matching ONNX Runtime 1.21.0 assets. Model weights and runtime binaries are ignored by Git and are reproduced by this command. All four fonts are bundled locally through Fontsource.

Optional settings are documented in `.env.example`. Copy it to `.env` when overriding defaults; leave `PYTHON` unset to use automatic virtual-environment detection. Never commit `.env`.

## Working features

- Public Instagram Reel/video-post, YouTube video/Shorts and TikTok video import via `yt-dlp`, including caption/description when available. Paste a direct link, `youtu.be` link, or TikTok `vm`/`vt`/`/t/` share link. The platform is detected automatically and shown in Media. A YouTube link with a playlist parameter imports only the selected video; profile links, whole playlists, and active/upcoming live streams are not supported.
- Imports retain the 15-minute/300 MB limits. Private, login-gated, age/region-restricted videos and platform rate limits can prevent downloads; no access-control bypass is used. TikTok must be reachable from the backend's network. The installed `yt-dlp[default]` package includes YouTube's EJS support, and the worker uses this app's Node executable for JavaScript processing.
- Device uploads up to 300 MB and 15 minutes, local thumbnails, searchable Media library, caption editing, downloads, and 7-day source retention.
- Saved projects with serialized autosave, revision-conflict detection, editable captions, and undo/redo for video edits.
- Fixed 9:16 Reel canvas (1080×1920), fill-frame crop, adjustable crop and fit-full-video.
- Text overlays with four bundled fonts, five text colors, positions, sizes and source-timeline timing.
- Five background swatches, custom HTML color input, and two/three-color gradients.
- Timeline split, disable/delete and restore; export skips disabled segments. Timings remain in source coordinates.
- Original audio, mute, Kim Vocal 2 vocal isolation and instrumental residual (`original - estimated vocals`), preview and apply.
- Browser audio processing: WebGPU preferred, WASM fallback (up to four threads with cross-origin isolation), exact 7680-point FFT, 44.1 kHz stereo, fixed model tensor, two-pass denoise and overlap-add. All DSP runs in a dedicated Worker; browser decoding precedes the Worker.
- FFmpeg MP4 export with H.264, AAC 48 kHz, 30 fps, even dimensions, `yuv420p`, fast-start, 20 Mbps video cap and preserved captions as separate text downloads.
- Export library with playback, video/caption downloads and deletion. Source/project stay intact when deleting an export.

Source imports are converted to a high-quality H.264 editing copy (CRF 18). This is not a bit-for-bit copy of the platform's original file. Export is another encode. Instagram upload acceptance has not been tested against a real account.

## Structure and future changes

```text
app/                 Next.js application, shared theme and workspace screen
components/          Editor and its tool panels
lib/                 Frontend API, canvas drawing, audio orchestration, types
shared/              Server-validated edit contract and supported video URL rules
server/app.mjs       Fastify routes and workspace access checks
server/repository.mjs SQLite persistence adapter
server/jobs.mjs      Serial media-job runner and worker protocol
worker/              Python downloader, normalization and FFmpeg rendering
public/audio/        Browser audio Worker and mixed-radix DSP
scripts/             Dev launcher, model setup and end-to-end smoke check
tests/               Validation, persistence, auth and DSP regressions
docs/                Target product plan and extension guide
```

Edit state is versioned JSON; source files are immutable after import. Background and text artwork use the same canvas functions as the preview, then FFmpeg composites those PNGs before applying timeline cuts. Vocal separation covers the full source so processed audio stays aligned as clips are removed/restored. Applying a stem uploads it to this application's storage for server rendering, not to an AI service.

`runtime/` holds SQLite, media, project derivatives and exports. Keep it on persistent storage and back it up. Opening a project refreshes its source's retention. Expired sources make associated projects unavailable until reimport; exported MP4s remain. Derivative cleanup beyond explicit export deletion is a follow-up task.

Current development adapters use SQLite, a single worker queue, and local files. PostgreSQL, Redis/BullMQ, S3/R2 signed storage, per-user ownership and resilient distributed jobs remain part of the [target plan](docs/PRODUCT_PLAN.md). The application does not claim those cloud services are already implemented.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
# While pnpm dev is running: creates clearly labelled disposable QA media
node scripts/smoke.mjs
```

The smoke check uploads a synthetic six-second stereo clip, verifies range playback, saves crop/overlay/caption edits, tests stale-write rejection, removes the middle two seconds and verifies a four-second 1080×1920 Reel export. Tests also cover FFT/STFT reconstruction. Real musical separation quality should be compared with the user's previously tested Kim Vocal 2 implementation before public release; synthetic tests establish execution/alignment, not perceptual quality.

Multi-platform validation covers supported URL forms, permission checks, platform tagging, queue routing, extractor selection, live/duration limits and the stdout protocol. A public YouTube sample completed a real download and normalization during local verification. The TikTok sample reached its extractor but the host connection timed out; successful TikTok downloading still needs verification on a network that can reach TikTok.

## Deployment and access

For a persistent Node/Python host, run `pnpm build`, install Python dependencies and the audio model, then `pnpm start`. Set `HOST=0.0.0.0`, a strong `WORKSPACE_PASSWORD`, and the exact HTTPS `PUBLIC_ORIGIN` behind a reverse proxy. The launcher refuses a non-loopback bind without a password. Members share the workspace; this is not per-user private storage.

Serve the app with COOP/COEP headers (configured in `next.config.mjs`) to enable WASM threads. The reverse proxy must allow 300 MB uploads and video range requests. Runtime files, `.env`, and SQLite must never be served as public static files. The API streams only record-referenced media files and checks the workspace session. This full pipeline needs a persistent Node/Python host; a static-only deployment cannot execute FFmpeg jobs.

## Development branches

`develop` is the integration branch; `main` receives tested checkpoints. Existing feature branches remain available for downloader, Media, editor, caption assistant, exports and infrastructure. Start future work from the latest `develop`, and merge changes without resetting unrelated branch work.

The caption feature stays on the roadmap and `feature/ai-caption-assistant`; no OpenAI API key is currently needed. See [extension guidance](docs/DEVELOPMENT.md) before adding a tool.
