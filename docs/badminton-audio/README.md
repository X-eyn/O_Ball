# Audio asset pipeline

Master explicitly requires gentle recorded indoor footsteps and game assets that do not trigger IDM/browser download dialogs.

Sources (all CC0, HQ previews archived here and in sources/): martian 42204 gym footwork (steps), dynamique 613723 rubber soles (taps), whi1ter1ce 708054 indoor court (scuffs), shakaharu 68247 sneaker skids (squeaks) and 88502 sneaker squeaks (squeals). Also archived, unused: craigsmith 479963/480442 (vintage tape hiss), conradts 190558, adegenerate 71224, Nolosoelite 708443 (crowd bed), monte32 405114, and the retired linoleum-sneakers-source.mp3 (heel-toe clicks read as hard shoes).

Rebuild in order:

1. `python tools/bake_badminton_steps.py` (ffmpeg on PATH) creates 36 takes in five kinds (tap, step, scuff, squeak, squeal; 48 kHz mono, peak-normalised, no limiter), fades and a -10.5 dBFS peak ceiling. The report records cut points and measured levels.
2. `node tools/pack_badminton_audio.js` puts all thirty-nine active recordings into one JSON bank, with byte lengths and SHA-256 hashes. Never fetch individual MP3/WAV files from gameplay code or attach them to HTML audio elements.
3. `node --test public/badminton/audio.test.mjs` checks exact bytes, integrity metadata, level bounds, contact timing and cleanup helpers.
4. `node tools/presentation_check.js http://127.0.0.1:3000/badminton/r/STEPS --footsteps` checks native decoded playback, actual keyboard movement, actual rig plants, bounded voices and network/download events. `CHROME` may select a browser executable. The harness owns a temporary profile and closes it after the check.

Runtime: one cached content-addressed JSON request, decode once, shared movement compressor, maximum three movement voices / twenty-four total. Distinct takes do not immediately repeat for an athlete. Body travel alone never triggers sound. Opponent footsteps are quieter; racket contacts briefly duck footsteps. No noise fallback for missing recordings, no continuous ambience, no per-step fetch or PCM generation.

When changing or adding assets, regenerate the bank, preserve content hashing and JSON MIME, and repeat the browser delivery check. Do not solve download interception by disabling IDM or changing the user's browser settings. Browser instrumentation proves the application's request behavior, not every third-party downloader configuration. Master remains the judge of subjective listening comfort.

Playback (audio.js + audio-voices.mjs): each voiced foot plant reports its movement (speed, sharpest turn since the last plant, speed shed in the last half second, lunge). Slow footwork is a tap, running a step, a sharp cut a scuff with a short squeak, a lunge or hard stop a heavy step with the long squeal, a landing the heaviest steps pitched down. Squeaks are accents with a per-athlete cooldown; the far athlete is quieter and low-passed. The heat lab (/badminton/heat) has a footstep sound check: audition buttons per kind and live footsteps following the movement loops.
