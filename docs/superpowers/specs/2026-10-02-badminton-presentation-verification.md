# Badminton presentation verification

Implemented locally on `codex/badminton-presentation`. Game: http://localhost:3000/badminton. Celebration inspector: http://localhost:3000/badminton/anim. No commit, push or publication was requested.

## Delivered behavior

- Eleven active local recordings support racket contact, material/net rustle, applause and eight new indoor sneaker footfalls. Footsteps follow actual rendered swing-to-plant contacts, vary takes without immediate repeats, have soft filtered transients and a separate compressor, duck under racket contacts and keep the opponent quieter. Three simultaneous movement voices maximum, twenty-four total. Takeoff and soft jump landings stay quiet; hard jump landings use the same recorded material palette, and dives use a quiet cloth rustle. The continuous synthetic crowd-noise loop and rally-driven gain buildup remain removed. Decoded buffers are reused; mute, pause and room exit release voices. Version 2 of the content-addressed `audio-bank.json` packages exact bytes with lengths and SHA-256 hashes; no individual audio-media URLs reach gameplay. The old concrete recording is excluded from the bank and playback.
- Server-authoritative heat rewards clean returns, perfects, parries and points; faults reduce it. It cools between shots/points, freezes during server pause and resets per match. Smooth meters, hysteresis, real simulated flame frames and bounded ember pools follow the heat tiers. Cold effects and settled clothing skip unnecessary updates.
- The indoor green sports mat uses local vinyl normal/roughness maps, roll seams and shoe scuffs. High quality keeps a matte roughness floor. Authored paint masks add irregular pigment edges, bristles and pores while retaining exact court dimensions.
- The net receives signed pre-collision shuttle velocity and contact position. Its fixed-step vertex simulation produces localized directional cupping, tangential drag, waves and damping, with pinned ends and a more tensioned top cord. Mesh and tape share deformation. Shuttle collision remains the authoritative fixed server plane; this is not two-way collision against deformed triangles.
- APEX COURT, FEATHER LAB and THE OFFICE OPEN campaigns scroll continuously around the perimeter with live matchup, score and match-point messages. Canvas textures refresh only when their content changes.
- Badminton-specific shirt/shorts geometry has baked drape, smooth normals, maintained skin weights, fabric detail and bounded outward hem motion. Matching shadow geometry deforms consistently. The current rig/model remains; this does not replace the athlete with a scanned human or run a general garment collision solver.
- Three deterministic point gestures include grip-axis 360 racket flourish, compact fist pump and racket salute. Interruptions and replay resets restore the grip. All variants are available in the animation player.

## Verification evidence

- Badminton simulation: 104 passing checks. Keyboard: 38, swipe: 37, trackpad: 43. Football simulation: 37; its renderer, human, kit and audio source files are unchanged.
- Presentation behavior: 17 passing checks, including heat rewards/decay/reset, net-event velocity, opposite directional impulses, strength, anchors, damping and bounded long frames. Heat tier/hysteresis/frame-rate checks pass.
- Athlete checks pass for cached isolated geometry, source normals, outward protection, skin weights, crotch winding, matching shadows, bounded motion, complete grip rotation and interruption states.
- Audio: six Node tests pass for exact bytes/integrity metadata, voice ownership/eviction, camera-relative panning, real foot-contact timing and suppressed states, nonrepeating take selection, and baked PCM format/peak/RMS/edge bounds. All eight mono 48 kHz takes are 260 ms, have a -10.5 dBFS peak ceiling and approximately -31.0 to -28.1 dBFS RMS before the quiet runtime mix.
- Native footstep integration passes on medium in Edge and Chrome: live keyboard movement plays recordings; four-second two-player rig runs play 29 and 26 recorded contacts respectively from all eight takes, with three movement voices maximum. Pausing produces zero sounds and releases voices. Initialization starts zero looping sources; body travel without rendered foot plants creates zero effects. Both browsers record exactly one JSON bank request, zero audio-media URL requests and zero browser download events. The served 410,882-byte bank has verified matching content hash, `application/json` MIME, immutable caching and no attachment disposition. This verifies game delivery behavior without changing IDM/browser settings; it does not certify every third-party download manager configuration.
- Native Chrome/Edge presentation integration verifies decoded event playback, burst voice limits, mute/pause/home cleanup, heat/fire shaders and real net mesh deflection. Medium was rechecked after adding the eight shoe takes; high and lite tiers were inspected during the original upgrade. Room exit also resets a forced interrupted racket flourish, garment motion and net motion. No runtime/shader errors in passing runs.
- Animation player lists 121 cases, scrubs deterministically, reaches racket contact, plays all three celebrations and restores neutral grip. Changing code reloads the same case and frame.
- Real-rig motion test: 88/88 pass, including jumps, dives, noisy input, hit-stop, frame spikes and broken rows.
- Reaction suite: 29/30 pass. The existing `net-kill` case misses the strict racket-contact limit at 6.9 cm. The same isolated case fails at the same 6.9 cm against the original HEAD export on port 3001; this upgrade did not introduce it.
- JavaScript syntax checks and `git diff --check` pass. Node emits a module-type detection warning when the standalone athlete test imports browser ES modules from this CommonJS package; browser imports are valid.

## Performance observations

Native ANGLE/D3D11 on NVIDIA RTX 3080 Ti, same 1440×900 headless browser settings, pixel ratio 1 and render scale 1. Original HEAD ran on an isolated temporary server, then the updated build ran sequentially. Captured roughly 425–448 steady frames after warming up, using callback CPU timing and disjoint GPU queries. These are standing/serve observations, not a sustained maximum-rally benchmark or a guarantee on other hardware.

| Tier/build | CPU median / p95 (ms) | GPU median / p95 (ms) | Draw calls / triangles |
|---|---:|---:|---:|
| Medium original | 2.6 / 4.1 | 3.02 / 5.10 | 75 / 42,347 |
| Medium updated | 3.9 / 7.1 | 2.88 / 5.01 | 75 / 43,851 |
| High original | 3.8 / 6.1 | 3.43 / 5.34 | 108 / 63,766 |
| High updated | 4.2 / 6.5 | 3.65 / 5.54 | 108 / 66,022 |

Earlier pairs varied materially, especially in CPU tails. High GPU median/p95 increased about 6.5%/3.8% in the final pair; medium GPU did not increase. The proposed strict 10% overall overhead target is **not established**, particularly for medium CPU timing. Cold VFX and unchanged heat HUD writes were removed, and settled garments retain stable uniforms and skip wave work. Further profiling on controlled workloads would be needed to certify that target. This report makes no zero-lag or universal frame-rate claim.

With full heat, maximum cards add five draws/eight triangles on medium/high, and three draws/four triangles on lite. Ember allocation is fixed at 20/44/80 points; net integration is capped at eight 1/120-second steps per update. Immediate repeated render stress checks exercise those paths but saturate the driver and do not represent normal frame latency. No unbounded geometry or voice growth was observed.

Audio decoding/playback and source levels were checked; subjective mix quality still needs Master's listening review. Selected screenshots are stored in `docs/badminton-presentation/court-high.png` and `kit-fire-detail-high.png`. Exact asset sources and processing are in `public/badminton/assets/SOURCES.md`.
