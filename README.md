# Local Video Library

Turn your local folder of videos into a clean, fast, personal streaming space in seconds 🚀

No heavy media server setup. No complex dashboard. Just run one command and start watching from desktop or phone 📱💻

### Why you'll like it ✨

- Instant local streaming with a polished web UI
- Smart resume playback and watched progress tracking
- Built-in thumbnail generation and folder previews
- Useful metadata right in the list (`duration • resolution • size`)
- Lightweight scripts for indexing, downloading, and converting videos

Whether it is your favorite sitcom archive, learning videos, or random clips, this project makes your library feel alive and easy to navigate 🎬

### Included out of the box

- recursive media indexing (`lib.json`)
- static web UI (`index.html`)
- local HTTP serving (`run`)
- optional public tunnel via ngrok
- helper scripts for downloading/converting videos

## Requirements

- `node` (for `build.js`)
- `ffmpeg` (for conversion scripts)
- `yt-dlp` (recommended for `yt`; `youtube-dl` fallback is limited)
- `ngrok` (optional, only if you use `./run -n`)

## Project Files

- `build.js` - scans folders recursively and builds `lib.json` from `.mp4` files
- `index.html` - frontend UI (folders/videos, playback, resume, thumbnails, metadata)
- `server.js` - lightweight static server + YouTube download API queue
- `run` - build + serve workflow with optional ngrok
- `yt` - download from YouTube into `youtube/`
- `convert-mkv` - convert `.mkv` to `.mp4`
- `convert-avi` - convert `.avi` to `.mp4`
- `lib.json` - generated media index used by the UI

## Quick Start

From project root:

```bash
./run
```

Then open:

```text
http://127.0.0.1:8081
```

## `run` Options

```bash
./run -h
```

Available options:
- `-n` enable ngrok tunnel
- `-p PORT` set HTTP port (default `8081`)
- `-a ADDRESS` set bind address (default `127.0.0.1`)

Examples:

```bash
# Default local run
./run

# Different port
./run -p 9090

# Expose via ngrok
./run -n

# Bind all interfaces (LAN access)
./run -a 0.0.0.0
```

## Build Library Index Only

```bash
node build.js
```

This regenerates `lib.json` atomically.

## Download / Convert Helpers

Download one YouTube URL into `youtube/`:

```bash
./yt "https://www.youtube.com/watch?v=..."
```

Convert media in current directory:

```bash
./convert-mkv
./convert-avi
```

## UI Features

- folder navigation with breadcrumbs
- video playback with prev/next/random
- search + status filter
- resume playback position
- watched progress per folder (`Watched X / Y`)
- video thumbnails (generated in browser, cached in IndexedDB)
- folder collage previews from cached thumbnails
- compact metadata line:
  - `duration • resolution • file size`
- last watched relative time (`Last watched 2d ago`)
- YouTube download from search field (paste URL + `Enter`)
  - downloads into the currently open folder in the UI

## Hidden Action

At root breadcrumb (`Library` as current item):
- triple-click `Library`
- confirm dialog appears
- if confirmed, thumbnail cache is cleared

## Client-Side Storage Keys

- `video-resume-v1` - resume positions
- `video-watched-v1` - watched markers + watched timestamp
- `video-meta-v1` - cached duration/resolution/size metadata
- IndexedDB `video-thumbnails-v1` / store `thumbs` - cached thumbnails

## Notes

- Thumbnail generation is sequential (one at a time) with a short delay between tasks.
- Mobile devices use a smaller thumbnail profile to reduce CPU/memory usage.
- If ngrok is enabled, your library may become publicly reachable. Use carefully.

## Troubleshooting

- `YouTube request failed` in UI:
  - ensure you started via `./run` (it launches `server.js` with API endpoints)
- `yt-dlp is required`:
  - install via `brew install yt-dlp`
- `ffmpeg is not installed`:
  - install ffmpeg and re-run conversion/download scripts
- thumbnails look stale:
  - use the hidden triple-click root action to clear thumbnail cache
