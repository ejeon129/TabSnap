# TabSnap MVP — Setup Guide

## What's Included

| File | Purpose |
|---|---|
| `TabSnap.jsx` | Interactive React frontend — URL input, processing visualization, tab viewer with playback, ASCII export |
| `pipeline.py` | Python backend — the real audio processing pipeline (download → separate → detect → map → render) |
| `TabSnap_Technical_Architecture.md` | Full architecture doc for reference |

---

## Quick Start: Frontend (Interactive Demo)

The `TabSnap.jsx` file is a self-contained React component. To run it:

### Option A: Use in Claude Artifacts
The `.jsx` file renders directly in Claude's artifact viewer — just open it.

### Option B: Add to a React project
```bash
npx create-next-app@latest tabsnap --typescript=false
cd tabsnap
# Copy TabSnap.jsx into src/ or app/
# Import and render: <TabSnap />
npm run dev
```

The frontend includes:
- URL input with platform auto-detection (TikTok, YouTube, Instagram)
- Tuning selector (Standard, Drop D, Half Step Down)
- Processing pipeline animation
- **Interactive tab grid** — color-coded strings, click any note, playback mode
- **ASCII tab view** with one-click copy
- 3 built-in demos (chord progression, blues riff, fingerpicking)
- The full fretboard mapping algorithm (beam search optimization)

---

## Quick Start: Backend (Real Transcription)

### 1. Install dependencies

```bash
# Create a virtual environment (recommended)
python -m venv tabsnap-env
source tabsnap-env/bin/activate  # or tabsnap-env\Scripts\activate on Windows

# Core dependencies
pip install yt-dlp basic-pitch librosa pretty-midi numpy

# Source separation (requires ~1.5GB download on first run)
pip install demucs

# Optional: for Guitar Pro export
pip install pyguitarpro
```

You also need **ffmpeg** installed:
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows — download from https://ffmpeg.org/download.html
```

### 2. Run on a video URL

```bash
# YouTube Shorts
python pipeline.py --url "https://youtube.com/shorts/YOUR_VIDEO_ID"

# TikTok
python pipeline.py --url "https://www.tiktok.com/@user/video/123456"

# Instagram Reels
python pipeline.py --url "https://www.instagram.com/reel/ABC123/"
```

### 3. Run on a local audio file

```bash
python pipeline.py --file my_guitar_cover.wav
```

### 4. Options

```bash
# Different tuning
python pipeline.py --file cover.wav --tuning drop_d

# JSON output (for the web frontend)
python pipeline.py --file cover.wav --format json --output tabs.json

# Save ASCII tabs to file
python pipeline.py --url "..." --output my_tabs.txt

# Adjust detection sensitivity
python pipeline.py --file cover.wav --onset-threshold 0.4 --frame-threshold 0.25
```

---

## How the Pipeline Works

```
URL or File
    │
    ▼
┌─────────────────┐
│ 1. Download      │  yt-dlp extracts audio as WAV, normalizes with ffmpeg
└────────┬────────┘
         ▼
┌─────────────────┐
│ 2. Separate      │  Demucs isolates guitar (htdemucs_6s for direct guitar
└────────┬────────┘  stem, falls back to htdemucs "other" stem)
         ▼
┌─────────────────┐
│ 3. Detect        │  Basic Pitch finds notes (pitch, onset, duration, velocity)
└────────┬────────┘  Falls back to librosa pyin if Basic Pitch unavailable
         ▼
┌─────────────────┐
│ 4. Map           │  Beam-search algorithm chooses optimal string/fret
└────────┬────────┘  positions minimizing hand movement and fret span
         ▼
┌─────────────────┐
│ 5. Render        │  ASCII tablature or JSON for the web viewer
└─────────────────┘
```

---

## Connecting Frontend to Backend

To make the frontend use real transcriptions instead of demos, you'd wrap `pipeline.py` in a FastAPI server:

```python
# server.py (next step after MVP)
from fastapi import FastAPI, BackgroundTasks
from pipeline import run_pipeline
import uuid, json

app = FastAPI()
jobs = {}

@app.post("/api/jobs")
async def create_job(url: str, tuning: str = "standard", bg: BackgroundTasks = None):
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "processing"}
    bg.add_task(process_job, job_id, url, tuning)
    return {"id": job_id}

async def process_job(job_id, url, tuning):
    try:
        result = run_pipeline(url=url, tuning=tuning, output_format="json")
        jobs[job_id] = {"status": "complete", "result": json.loads(result)}
    except Exception as e:
        jobs[job_id] = {"status": "failed", "error": str(e)}

@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    return jobs.get(job_id, {"status": "not_found"})
```

---

## Tips for Best Results

1. **Solo guitar covers work best** — the fewer other instruments, the better
2. **Clean audio matters** — covers recorded with a direct input or close mic outperform phone recordings
3. **Lower the onset threshold** (e.g., `--onset-threshold 0.3`) if you're missing quiet notes
4. **Raise it** (e.g., `--onset-threshold 0.7`) if you're getting too many false notes
5. **Standard tuning is assumed** — always set `--tuning` if the cover uses an alternate tuning
6. **GPU helps** — Demucs is ~5x faster on a GPU. It works on CPU but takes longer (~30s for a 30s clip)
