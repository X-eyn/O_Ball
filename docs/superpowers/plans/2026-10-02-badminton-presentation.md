# Badminton Presentation Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent physics and athlete tasks; integrate and verify in the current chat.

**Goal:** Implement the approved seven presentation upgrades in the existing indoor badminton game.

**Architecture:** Server heat and collision events drive bounded client effects. Local licensed assets feed court, audio, and fire; small focused modules own net dynamics and athlete presentation.

**Tech stack:** Node.js, Three.js, Web Audio, existing native browser checks.

## Global constraints

- Keep the indoor sports mat and existing court rules and controls.
- Heat is cosmetic: 0–100, return +4, perfect +6, parry +8, point +12, fault -20, rally decay 2/s, point decay 8/s, pause freezes, new match resets.
- Preserve football presentation; restrict kit enhancements to badminton.
- Bounded physics substeps, particles, and audio voices; no per-frame geometry rebuilding.
- Do not push or publish. Keep local changes reviewable.

## Task 1: Physics and heat

Files: shared/badminton.js, public/badminton/net-dynamics.mjs, tools/presentation_test.js.

- [x] Write failing tests for heat reward, cooling, fault, pause/reset, snapshot, and signed pre-damped net collision velocity.
- [x] Run `node tools/presentation_test.js` and confirm expected missing behavior.
- [x] Add server heat and velocity events; export NetDynamics with constructor(width, height, cols, rows), impact(event), step(dt), reset(), positions/base typed arrays and cols/rows.
- [x] Verify signed deflection, anchors, force scaling, damping, repeated contacts and long frames with real NetDynamics; run badminton and input regression tests.

## Task 2: Athlete clothing and celebrations

Files: public/badminton/apparel.js, public/badminton/anim.js, public/badminton/animplayer.js, focused athlete tests.

- [x] Add checks for a complete grip-centered rotation and neutral reset after interruption.
- [x] Prepare badminton-only garment geometry/materials once, with baked folds, seam detail, fabric texture, and bounded edge motion; retain skeleton skinning.
- [x] Add deterministic racket flourish, fist pump and salute within point timing; expose all variants in the animation player.
- [x] Run motion/reaction checks and inspect close-up garment and grip frames.

## Task 3: Local presentation assets and renderer

Files: public/badminton/assets/, public/badminton/render3d.js, public/badminton/heat-vfx.js, assets.js.

- [x] Download and optimize CC0 mat maps, real simulated fire flipbook and sample audio; document exact sources and modifications.
- [x] Replace mat shading and paint-mask rendering, integrate dynamic net and tape, add bounded heat/fire effects.
- [x] Replace perimeter content with campaign and live match messages; preserve continuous scroll and update only on content changes.
- [x] Check asset delivery, graphics tiers, screenshots, and before/after renderer timing.

## Task 4: Audio and UI integration

Files: public/badminton/audio.js, public/badminton/client.js, public/badminton/index.html, public/badminton/style.css.

- [x] Add sample-backed differentiated sounds, room reflections, camera-relative pan, voice limits and cleanup; retain graceful fallback and mute.
- [x] Add compact heat meter and tier transitions; pass collision velocity and heat snapshots to the renderer.
- [x] Verify activation/mute, decoding, event playback and paused heat flow.

## Task 5: Review and verification

- [x] Review integrated changes for physics stability, resource disposal, cross-sport effects and reload correctness.
- [x] Run simulation/input tests, real browser and animation-player checks.
- [x] Record visual captures and compare render-time measurements; report hardware/software limits honestly.
- [x] Leave the game running and provide the badminton link and concise completion status.
