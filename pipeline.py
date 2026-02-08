#!/usr/bin/env python3
"""
TabSnap Pipeline — Audio-to-Guitar-Tab Transcription
=====================================================

This is the real processing backend. It downloads audio from short-form video
URLs, isolates the guitar, detects pitches, maps to fretboard positions, and
outputs guitar tablature.

SETUP:
    pip install yt-dlp demucs basic-pitch librosa pretty-midi numpy

USAGE:
    # From a URL
    python pipeline.py --url "https://youtube.com/shorts/ABC123"

    # From a local audio file
    python pipeline.py --file my_guitar_cover.wav

    # With options
    python pipeline.py --url "..." --tuning drop_d --output tabs.txt --format ascii

    # Output as JSON (for the web frontend)
    python pipeline.py --file cover.wav --format json --output tabs.json
"""

import argparse
import json
import os
import sys
import tempfile
import subprocess
import logging
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("tabsnap")


# ─── TUNING DEFINITIONS ─────────────────────────────────────────────────────

TUNINGS = {
    "standard":  {"label": "Standard",       "notes": [64, 59, 55, 50, 45, 40]},  # e B G D A E (high→low)
    "drop_d":    {"label": "Drop D",         "notes": [64, 59, 55, 50, 45, 38]},  # e B G D A D
    "half_down": {"label": "Half Step Down", "notes": [63, 58, 54, 49, 44, 39]},  # eb Bb Gb Db Ab Eb
    "open_g":    {"label": "Open G",         "notes": [62, 59, 55, 50, 47, 38]},  # D B G D G D
    "dadgad":    {"label": "DADGAD",         "notes": [62, 57, 55, 50, 45, 38]},  # D A G D A D
}

STRING_LABELS = ["e", "B", "G", "D", "A", "E"]


# ─── DATA CLASSES ────────────────────────────────────────────────────────────

@dataclass
class NoteEvent:
    """A detected note from the audio."""
    midi_pitch: int
    onset_time: float   # seconds
    offset_time: float  # seconds
    velocity: int = 100

@dataclass
class TabPosition:
    """A fret position on the guitar."""
    string: int  # 0=high e, 5=low E
    fret: int

@dataclass
class TabEvent:
    """A mapped tab event ready for rendering."""
    time: float
    duration: float
    positions: list = field(default_factory=list)
    chord: Optional[str] = None
    notes: list = field(default_factory=list)


# ─── STAGE 1: DOWNLOAD AUDIO ────────────────────────────────────────────────

def download_audio(url: str, output_dir: str) -> str:
    """Download audio from a short-form video URL using yt-dlp."""
    logger.info(f"Downloading audio from: {url}")

    output_path = os.path.join(output_dir, "audio.wav")

    cmd = [
        "yt-dlp",
        "--extract-audio",
        "--audio-format", "wav",
        "--audio-quality", "0",
        "--output", os.path.join(output_dir, "audio.%(ext)s"),
        "--no-playlist",
        "--quiet",
        url,
    ]

    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        logger.error(f"yt-dlp failed: {e.stderr}")
        raise RuntimeError(f"Failed to download audio: {e.stderr}")
    except FileNotFoundError:
        raise RuntimeError("yt-dlp not found. Install with: pip install yt-dlp")

    if not os.path.exists(output_path):
        # yt-dlp might save with a different extension first
        for f in Path(output_dir).glob("audio.*"):
            if f.suffix == ".wav":
                output_path = str(f)
                break

    if not os.path.exists(output_path):
        raise RuntimeError("Audio download succeeded but WAV file not found")

    # Normalize audio levels with ffmpeg
    normalized = os.path.join(output_dir, "audio_norm.wav")
    try:
        subprocess.run([
            "ffmpeg", "-y", "-i", output_path,
            "-filter:a", "loudnorm=I=-14:TP=-1:LRA=11",
            "-ar", "44100", "-ac", "1",
            normalized,
        ], check=True, capture_output=True)
        os.replace(normalized, output_path)
    except (subprocess.CalledProcessError, FileNotFoundError):
        logger.warning("ffmpeg normalization failed, using raw audio")

    logger.info(f"Audio saved to: {output_path}")
    return output_path


# ─── STAGE 2: SOURCE SEPARATION ─────────────────────────────────────────────

def separate_guitar(audio_path: str, output_dir: str) -> str:
    """Isolate guitar from mixed audio using Demucs."""
    logger.info("Running source separation with Demucs...")

    try:
        # Prefer htdemucs_6s which has a dedicated guitar stem
        # Falls back to htdemucs (4 stems) where guitar is in "other"
        for model in ["htdemucs_6s", "htdemucs"]:
            try:
                cmd = [
                    "demucs",
                    "-n", model,
                    "-o", output_dir,
                    "--filename", "{stem}.{ext}",
                    audio_path,
                ]
                subprocess.run(cmd, check=True, capture_output=True, text=True)

                # Find the guitar or "other" stem in the output
                # Demucs outputs to: <output_dir>/<model_name>/<stem>.wav
                model_dir = Path(output_dir) / model
                if not model_dir.exists():
                    # Some versions use the track name as subfolder
                    track_name = Path(audio_path).stem
                    model_dir = Path(output_dir) / model / track_name

                # Look for stems in priority order
                for stem_name in ["guitar", "other", "no_vocals"]:
                    for ext in [".wav", ".mp3"]:
                        stem_path = model_dir / f"{stem_name}{ext}"
                        if stem_path.exists():
                            logger.info(f"Guitar stem ({stem_name}): {stem_path}")
                            return str(stem_path)

                # Search recursively if standard paths didn't work
                for stem_name in ["guitar", "other", "no_vocals"]:
                    matches = list(Path(output_dir).rglob(f"*{stem_name}*"))
                    if matches:
                        logger.info(f"Guitar stem found: {matches[0]}")
                        return str(matches[0])

                logger.warning(f"Model {model} ran but no guitar stem found, trying next model...")

            except subprocess.CalledProcessError:
                logger.warning(f"Model {model} failed, trying next...")
                continue

        logger.warning("Demucs separation failed — using original audio (results may be less accurate)")
        return audio_path

    except FileNotFoundError:
        logger.warning("Demucs not installed — using original audio (results may be less accurate)")
        return audio_path


# ─── STAGE 3: PITCH DETECTION ───────────────────────────────────────────────

def detect_pitches(
    audio_path: str,
    output_dir: str,
    onset_threshold: float = 0.5,
    frame_threshold: float = 0.3,
    min_note_ms: float = 50,
) -> list:
    """Detect notes in the guitar audio using Basic Pitch."""
    logger.info("Detecting pitches with Basic Pitch...")

    try:
        from basic_pitch.inference import predict
        from basic_pitch import ICASSP_2022_MODEL_PATH

        model_output, midi_data, note_events = predict(
            audio_path,
            onset_threshold=onset_threshold,
            frame_threshold=frame_threshold,
            minimum_note_length=min_note_ms,
        )

        notes = []
        for note in note_events:
            # note_events format: (start_time, end_time, pitch_midi, velocity, pitch_bend)
            n = NoteEvent(
                midi_pitch=int(note[2]),
                onset_time=float(note[0]),
                offset_time=float(note[1]),
                velocity=int(note[3]) if len(note) > 3 else 100,
            )
            notes.append(n)

        # Also save the MIDI for reference
        midi_path = os.path.join(output_dir, "detected.mid")
        midi_data.write(midi_path)
        logger.info(f"Detected {len(notes)} notes, MIDI saved to {midi_path}")

        return notes

    except ImportError:
        logger.warning("Basic Pitch not available. Falling back to librosa pitch detection...")
        return _fallback_pitch_detection(audio_path)


def _fallback_pitch_detection(audio_path: str) -> list:
    """Simple monophonic pitch detection fallback using librosa."""
    try:
        import librosa

        y, sr = librosa.load(audio_path, sr=44100, mono=True)

        # Onset detection
        onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time")

        # Pitch detection using pyin (probabilistic YIN)
        f0, voiced_flag, voiced_probs = librosa.pyin(
            y, fmin=librosa.note_to_hz("E2"), fmax=librosa.note_to_hz("E6"),
            sr=sr, frame_length=2048,
        )
        times = librosa.times_like(f0, sr=sr)

        notes = []
        for i, onset in enumerate(onsets):
            # Find the pitch at this onset time
            idx = np.argmin(np.abs(times - onset))
            if voiced_flag[idx] and f0[idx] is not None and not np.isnan(f0[idx]):
                midi = int(round(librosa.hz_to_midi(f0[idx])))
                offset = onsets[i + 1] if i + 1 < len(onsets) else onset + 0.25
                notes.append(NoteEvent(
                    midi_pitch=midi,
                    onset_time=float(onset),
                    offset_time=float(offset),
                    velocity=int(voiced_probs[idx] * 127) if voiced_probs[idx] is not None else 80,
                ))

        logger.info(f"Fallback detected {len(notes)} notes (monophonic)")
        return notes

    except ImportError:
        raise RuntimeError("Neither basic-pitch nor librosa is installed. Install with: pip install basic-pitch librosa")


# ─── STAGE 4: FRETBOARD MAPPING ─────────────────────────────────────────────

def get_candidates(midi_note: int, tuning: str, max_fret: int = 22) -> list:
    """Get all valid (string, fret) positions for a MIDI note."""
    open_strings = TUNINGS[tuning]["notes"]
    candidates = []
    for s in range(6):
        fret = midi_note - open_strings[s]
        if 0 <= fret <= max_fret:
            candidates.append(TabPosition(string=s, fret=fret))
    return candidates


def optimize_single(candidates: list, last_positions: list) -> TabPosition:
    """Choose the best position for a single note."""
    best, best_cost = candidates[0], float("inf")
    for c in candidates:
        cost = c.fret * 0.1
        if last_positions:
            min_dist = min(
                abs(c.fret - lp.fret) + abs(c.string - lp.string) * 2
                for lp in last_positions
            )
            cost += min_dist * 0.5
        if c.fret == 0:
            cost -= 0.3  # prefer open strings
        if cost < best_cost:
            best_cost = cost
            best = c
    return best


def optimize_chord(candidate_sets: list, last_positions: list) -> list:
    """Beam search to find optimal positions for a chord."""
    if not candidate_sets:
        return []
    if len(candidate_sets) == 1:
        return [optimize_single(candidate_sets[0], last_positions)]

    beam = [{"positions": [], "cost": 0, "used": set()}]

    for candidates in candidate_sets:
        next_beam = []
        for state in beam:
            for c in candidates:
                if c.string in state["used"]:
                    continue
                frets = [p.fret for p in state["positions"]] + [c.fret]
                frets_nonzero = [f for f in frets if f > 0]
                span = (max(frets_nonzero) - min(frets_nonzero)) if frets_nonzero else 0
                if span > 5:
                    continue

                cost = state["cost"] + c.fret * 0.05 + span * 0.3
                if c.fret == 0:
                    cost -= 0.2
                if last_positions:
                    min_dist = min(abs(c.fret - lp.fret) for lp in last_positions)
                    cost += min_dist * 0.2

                used = state["used"] | {c.string}
                next_beam.append({
                    "positions": state["positions"] + [c],
                    "cost": cost,
                    "used": used,
                })

        next_beam.sort(key=lambda x: x["cost"])
        beam = next_beam[:20]

    if beam:
        return beam[0]["positions"]
    return [cs[0] for cs in candidate_sets if cs]


def map_to_fretboard(notes: list, tuning: str = "standard", chord_window_ms: float = 20) -> list:
    """Convert detected notes to fretboard positions."""
    logger.info(f"Mapping {len(notes)} notes to fretboard (tuning: {tuning})...")

    # Group simultaneous notes into chords
    groups = []
    current_group = []

    sorted_notes = sorted(notes, key=lambda n: n.onset_time)

    for note in sorted_notes:
        if not current_group:
            current_group.append(note)
        elif abs(note.onset_time - current_group[0].onset_time) < chord_window_ms / 1000:
            current_group.append(note)
        else:
            groups.append(current_group)
            current_group = [note]

    if current_group:
        groups.append(current_group)

    # Map each group to fretboard positions
    tab_events = []
    last_positions = []

    for group in groups:
        candidate_sets = [get_candidates(n.midi_pitch, tuning) for n in group]
        # Filter out notes with no valid positions
        valid = [(cs, n) for cs, n in zip(candidate_sets, group) if cs]
        if not valid:
            continue

        candidate_sets = [cs for cs, _ in valid]
        group_notes = [n for _, n in valid]

        positions = optimize_chord(candidate_sets, last_positions)

        onset = min(n.onset_time for n in group_notes)
        offset = max(n.offset_time for n in group_notes)

        tab_events.append(TabEvent(
            time=onset,
            duration=offset - onset,
            positions=positions,
            notes=[n.midi_pitch for n in group_notes],
        ))

        last_positions = positions

    logger.info(f"Mapped to {len(tab_events)} tab events")
    return tab_events


# ─── STAGE 5: TEMPO & QUANTIZATION ──────────────────────────────────────────

def detect_tempo(audio_path: str) -> float:
    """Detect BPM of the audio."""
    try:
        import librosa
        y, sr = librosa.load(audio_path, sr=44100)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(tempo[0]) if hasattr(tempo, '__len__') else float(tempo)
        logger.info(f"Detected tempo: {bpm:.1f} BPM")
        return bpm
    except ImportError:
        logger.warning("librosa not available, defaulting to 120 BPM")
        return 120.0


# ─── STAGE 6: TAB RENDERING ─────────────────────────────────────────────────

def render_ascii(tab_events: list, tuning: str = "standard") -> str:
    """Render tab events as ASCII guitar tablature."""
    per_line = 8
    lines = []
    total = len(tab_events)

    lines.append(f"# TabSnap Transcription")
    lines.append(f"# Tuning: {TUNINGS[tuning]['label']}")
    lines.append(f"# Notes: {total}")
    lines.append("")

    for chunk_start in range(0, total, per_line):
        chunk = tab_events[chunk_start:chunk_start + per_line]

        # Chord labels
        chord_line = "    "
        has_chords = False
        for ev in chunk:
            c = ev.chord or ""
            if c:
                has_chords = True
            chord_line += c.ljust(6)
        if has_chords:
            lines.append(chord_line)

        # Tab lines
        for s in range(6):
            row = STRING_LABELS[s] + "|"
            for ev in chunk:
                pos = next((p for p in ev.positions if p.string == s), None)
                fret_str = str(pos.fret) if pos else "-"
                row += "-" + fret_str.ljust(5, "-")
            row += "|"
            lines.append(row)

        lines.append("")

    return "\n".join(lines)


def render_json(tab_events: list, tuning: str, bpm: float) -> dict:
    """Render tab events as JSON for the web frontend."""
    events = []
    for ev in tab_events:
        events.append({
            "time": round(ev.time, 3),
            "duration": round(ev.duration, 3),
            "positions": [{"string": p.string, "fret": p.fret} for p in ev.positions],
            "chord": ev.chord,
            "notes": ev.notes,
        })

    return {
        "tuning": tuning,
        "tuning_label": TUNINGS[tuning]["label"],
        "bpm": round(bpm, 1),
        "event_count": len(events),
        "events": events,
    }


# ─── MAIN PIPELINE ──────────────────────────────────────────────────────────

def run_pipeline(
    url: str = None,
    audio_file: str = None,
    tuning: str = "standard",
    output_format: str = "ascii",
    output_path: str = None,
    onset_threshold: float = 0.5,
    frame_threshold: float = 0.3,
) -> str:
    """Run the full transcription pipeline."""

    if tuning not in TUNINGS:
        raise ValueError(f"Unknown tuning: {tuning}. Options: {list(TUNINGS.keys())}")

    with tempfile.TemporaryDirectory(prefix="tabsnap_") as tmp:
        # Stage 1: Get audio
        if url:
            audio_path = download_audio(url, tmp)
        elif audio_file:
            audio_path = audio_file
            if not os.path.exists(audio_path):
                raise FileNotFoundError(f"Audio file not found: {audio_path}")
        else:
            raise ValueError("Provide either --url or --file")

        # Stage 2: Isolate guitar
        guitar_path = separate_guitar(audio_path, tmp)

        # Stage 3: Detect pitches
        notes = detect_pitches(guitar_path, tmp, onset_threshold, frame_threshold)

        if not notes:
            logger.warning("No notes detected! The audio may not contain guitar.")
            return "No notes detected."

        # Stage 4: Map to fretboard
        tab_events = map_to_fretboard(notes, tuning)

        # Stage 5: Detect tempo
        bpm = detect_tempo(audio_path)

        # Stage 6: Render
        if output_format == "json":
            result = json.dumps(render_json(tab_events, tuning, bpm), indent=2)
        else:
            result = render_ascii(tab_events, tuning)

        # Save output
        if output_path:
            with open(output_path, "w") as f:
                f.write(result)
            logger.info(f"Output saved to: {output_path}")
        else:
            print(result)

        return result


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="TabSnap — Convert guitar covers to tablature",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python pipeline.py --url "https://youtube.com/shorts/ABC123"
  python pipeline.py --file cover.wav --tuning drop_d
  python pipeline.py --url "..." --format json --output tabs.json
        """,
    )

    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--url", help="TikTok, YouTube Shorts, or Instagram Reels URL")
    source.add_argument("--file", help="Local audio file path")

    parser.add_argument("--tuning", default="standard", choices=list(TUNINGS.keys()),
                        help="Guitar tuning (default: standard)")
    parser.add_argument("--format", default="ascii", choices=["ascii", "json"],
                        help="Output format (default: ascii)")
    parser.add_argument("--output", "-o", help="Output file path (prints to stdout if omitted)")
    parser.add_argument("--onset-threshold", type=float, default=0.5,
                        help="Note onset detection sensitivity 0-1 (default: 0.5)")
    parser.add_argument("--frame-threshold", type=float, default=0.3,
                        help="Note sustain detection sensitivity 0-1 (default: 0.3)")

    args = parser.parse_args()

    try:
        run_pipeline(
            url=args.url,
            audio_file=args.file,
            tuning=args.tuning,
            output_format=args.format,
            output_path=args.output,
            onset_threshold=args.onset_threshold,
            frame_threshold=args.frame_threshold,
        )
    except Exception as e:
        logger.error(f"Pipeline failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
