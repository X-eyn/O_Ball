"""Bake the court-shoe sound bank: six kinds of foot contact, from documented CC0 recordings.

  tap     soft split-step / slow shuffle     quiet rubber soles on a hard floor (dynamique 613723)
  step    a running plant                    gym footwork with squeaks (martian 42204)
  scuff   a sole dragged on a quick cut      one player on an indoor court (whi1ter1ce 708054)
  squeak  the short chirp of a sharp cut     sneaker skids on a gym floor (shakaharu 68247)
  squeal  the long rubber squeal of a lunge  rubber sneaker squeaks (shakaharu 88502) + skids

Jump landings reuse the heaviest step takes, pitched down (the heavy-running source was mostly
tape hiss and the gym landings were heel-toe doubles).

Onsets were picked by measuring every event in the sources (onset flux; click = energy above
3 kHz against the body; squeak = a tonal peak at 0.9-5 kHz; ball bounce = a pitched ~83 Hz ring
holding most energy under 150 Hz; double hit = a second peak within 160 ms) and checking each
candidate's spectrogram. Basketball dribbles and heel-toe doubles are excluded.

Requires ffmpeg on PATH. Sources stay in docs/badminton-audio/; runtime uses only the JSON bank.
"""
from array import array
from pathlib import Path
import json
import math
import subprocess
import sys
import wave

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs/badminton-audio"
OUT = ROOT / "public/badminton/assets"
RATE = 48000
SRC = {
    "gym": DOCS / "gym-footwork-source.mp3",
    "rubber": DOCS / "sources/rubber-shoes-dynamique-613723.mp3",
    "court": DOCS / "sources/basketball-player-whi1ter1ce-708054.mp3",
    "skid": DOCS / "sources/sneaker-skid-shakaharu-68247.mp3",
    "squeak": DOCS / "sources/sneaker-squeak-shakaharu-88502.mp3",
}
# kind: (onsets as (source, seconds), length s, peak dB, filters)
KINDS = {
    "tap": ([("rubber", t) for t in (2.93, 4.67, 8.47, 10.38, 11.35, 12.24, 14.95, 6.48)], 0.16, -15.0,
            "highpass=f=60,lowpass=f=7000,afftdn=nf=-45"),
    "step": ([("gym", t) for t in (10.415, 11.135, 11.460, 12.960, 15.310, 21.440, 23.615, 24.365)], 0.18, -11.0,
             "highpass=f=70,lowpass=f=7000"),
    "scuff": ([("court", t) for t in (2.15, 2.68, 3.77, 4.68, 6.20, 8.77)], 0.20, -13.0,
              "highpass=f=140,lowpass=f=9000,afftdn=nf=-45"),
    "squeak": ([("skid", t) for t in (4.54, 14.235, 20.75, 23.29, 28.805, 30.305, 32.965, 40.78)], 0.26, -14.0,
               "highpass=f=450,lowpass=f=9000,afftdn=nf=-50"),
    "squeal": ([("squeak", t) for t in (4.64, 5.77, 6.965, 8.65)] + [("skid", t) for t in (16.25, 49.015)], 0.42, -13.0,
               "highpass=f=400,lowpass=f=9000,afftdn=nf=-50"),
}
LEAD = 0.012  # start just before the detected onset so the attack stays whole
PRE = 0.25    # pre-roll so the denoiser settles before the event; trimmed after filtering


def run(args, data=None):
    out = subprocess.run(args, input=data, check=True, capture_output=True).stdout
    samples = array("f"); samples.frombytes(out)
    if sys.byteorder != "little": samples.byteswap()
    return samples


report = []
for kind, (onsets, length, peak_db, filters) in KINDS.items():
    for i, (src, onset) in enumerate(onsets):
        start = max(0.0, onset - PRE)
        trim = onset - start - LEAD
        chain = (f"{filters},atrim=start={trim:.3f}:duration={length:.3f},asetpts=PTS-STARTPTS,"
                 f"afade=t=in:d=0.003,afade=t=out:st={length * 0.35:.3f}:d={length * 0.65:.3f}:curve=exp")
        samples = run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", str(SRC[src]), "-t", f"{length + PRE:.3f}",
                       "-ac", "1", "-ar", str(RATE), "-af", chain, "-f", "f32le", "-"])
        n = round(RATE * length)
        samples = (samples + array("f", [0.0] * n))[:n]
        # peak-normalise only: no limiter, so each contact keeps its natural attack against its decay
        gain = 10 ** (peak_db / 20) / max(1e-9, max(abs(s) for s in samples))
        samples = array("f", (s * gain for s in samples))
        samples[0] = samples[-1] = 0.0
        pk = max(abs(s) for s in samples)
        rms = math.sqrt(sum(s * s for s in samples) / len(samples))
        pcm = array("h", (round(max(-1, min(1, s)) * 32767) for s in samples))
        if sys.byteorder != "little": pcm.byteswap()
        name = f"court-{kind}-{i + 1:02d}.wav"
        with wave.open(str(OUT / name), "wb") as dest:
            dest.setparams((1, 2, RATE, 0, "NONE", "not compressed")); dest.writeframes(pcm.tobytes())
        report.append({"file": name, "kind": kind, "source": SRC[src].name, "onset": onset, "duration": length,
                       "peakDb": round(20 * math.log10(pk), 2), "rmsDb": round(20 * math.log10(rms), 2)})
(DOCS / "step-bake-report.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({k: sum(1 for r in report if r["kind"] == k) for k in KINDS}))
