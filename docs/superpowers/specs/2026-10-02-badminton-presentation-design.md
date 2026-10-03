# Badminton presentation upgrade — approved design

Status: approved by Master with "Yes proceed". All seven areas are implemented locally. See `2026-10-02-badminton-presentation-verification.md` for evidence, performance measurements and remaining limits.

## Direction and alternatives

Master selected a realistic indoor badminton sports mat. Keep the tournament arena and existing playable court dimensions. Upgrade all seven requested areas together, with separate modules for heat, net dynamics, and reusable presentation assets.

Recommended approach: real downloaded textures and sound samples, a small physical net simulation, and rig-bound clothing with baked folds and bounded secondary motion. This balances visual quality and browser performance.

Alternative: simulate both full garments and the net at runtime. This adds collision and stability costs, especially on integrated graphics, without guaranteeing better silhouettes.

Alternative: use static textures and canned net wobble only. This is cheaper, but cannot deliver the requested directional contact response or satisfying clothing movement.

## 1. Audio

Use local decoded samples for racket contact, net rustle, shoes, and restrained arena applause. Layer tightly controlled synthesized transients where useful. Differentiate soft touches, drives, smashes, and perfect contacts; vary sample pitch subtly to avoid repetition. Position court effects according to the camera, keep interface cues centered, and add short room reflections. Pool reusable buffers, limit overlapping voices, use a compressor to control peaks, and preserve mute and browser gesture activation. Missing samples fall back to the existing sound path. Verify by listening as well as checking event scheduling and voice cleanup.

## 2. Heat and fire

Proposed heat is earned presentation momentum, with no shuttle-speed or scoring bonus. Keep its state on the server for agreement between players and spectators. Range: 0–100. A clean return adds 4, perfect contact adds another 6, a parry adds 8, and a point win adds 12. Heat decays at 2 per second during an active rally and 8 per second between points; a player's fault subtracts 20. Pause freezes it, and a new match resets it.

Visual tiers: below 30 normal; 30–59 warm amber; 60–84 hot with embers; 85–100 on fire. Smooth displayed intensity and use threshold hysteresis to prevent flicker. Show a compact readable meter. Fire uses a downloaded simulation flipbook, bounded particle counts, restrained light, and a short audio cue on tier changes. Place effects around the racket and behind the athlete; preserve shuttle and timing-ring readability. Reduced graphics tiers use fewer particles.

## 3. Indoor court and painted lines

Use a physically shaded fine-grain vinyl/rubber sports mat with appropriate normal and roughness maps, subtle roll seams, and restrained shoe scuffs. Retain green play area and blue surround. Tile material detail at a plausible world scale rather than stretching a photograph across the arena. Avoid rubber floor tiles with conspicuous square joints.

Use a separate paint mask for white court markings: slight edge variation, pigment grain, and restrained wear. Keep full rule-defined geometry and legibility. White brush-painted lines suit the selected indoor mat. Load assets locally; texture-load failure leaves a usable procedural court. Cap texture resolution by graphics tier.

## 4. Net physics

The server remains authoritative for shuttle flight and contact. Extend the net event with incoming velocity before collision damping. Feed that signed vector, contact position, and shuttle mass into a fixed-step damped cloth grid with pinned end anchors, a tensioned top cord, and a freer lower edge. Apply a localized distributed impulse, tangential drag, and short local cupping around the contact. Allow waves to propagate and settle naturally. Update mesh and tape from the same state, so the tape cannot float independently.

This is real net vertex dynamics; the shuttle collision continues to use the authoritative net plane. Full two-way shuttle-to-deformed-cloth collision would require matching all flight prediction and contact planning and is outside this first upgrade. Bound displacement and integration substeps, pause cleanly, and verify opposite-side impacts, glancing contacts, stronger hits, repeat hits, long frames, and return to rest.

## 5. Perimeter advertisements

Create a configurable rotating set of coherent fictional sports campaigns, event identity, and live tournament messages. Example campaign: APEX COURT — FIND YOUR NEXT LEVEL. Add clear logos, concise taglines, and consistent campaign colors. Include current matchup and match-point information where appropriate. Coordinate scrolling by physical board length and orientation for a continuous readable perimeter marquee. Bake each campaign texture when its content changes; never redraw canvas every frame.

## 6. Clothing

Replace the body-hugging appearance with a recognizable athletic shirt and shorts silhouette: clean sleeve hems, collar, side panels, waistband, leg openings, and seam detail. Reuse the current skeleton and skin weights, with prepared bind-pose drape and baked fold shapes. Add small velocity-driven motion at sleeve, shirt hem, and shorts edges; constrain movement away from the body and blend back without delay. Use realistic fabric normal/roughness detail and purposeful team colors.

Cache prepared geometry with a versioned key. Keep badminton-specific kit choices isolated from the football presentation. Do not run a general garment collision solver or rebuild garment geometry every frame. These methods reduce cost; actual frame time must still be measured before claiming performance.

## 7. Point-win mini celebrations

Add three short variants: a handle-pivot 360-degree racket flourish, a restrained fist pump, and a racket salute. The flourish includes anticipation, wrist initiation, a complete smooth rotation around the grip, and an eased return to ready. Hold the racket attachment at the hand and blend the body pose with planted feet. Fit ordinary point celebrations within the existing 110-tick point interval, around 1.0–1.3 seconds; use a stronger finish on match win. Choose variants deterministically from the point event. Reset racket pivot and animation state on serve, room exit, replay reset, and interrupted transitions.

Expose the celebrations in the existing animation player so Master can inspect slow motion, grip stability, and transitions.

## Asset candidates researched

- Mat detail candidate: ambientCG Plastic 010, a neutral smooth PBR material with CC0 licensing. Evaluate appearance before selecting it; tint and tune it for vinyl sports flooring. https://ambientcg.com/view?id=Plastic010
- Fire candidate: CGHEVEN Ground Fire 03 Side, a 4K simulated 6×6 flipbook with CC0 licensing. Evaluate silhouette for small racket/athlete effects and select a better source variant if needed. https://cgheven.com/assets/ground-fire-03-side-flipbook-6x6
- Fire fallback source: Unity Labs CC0 Houdini image sequences and flipbooks. https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks
- Contact audio candidate: Breviceps's CC0 racket hit. Audition for suitability to a shuttle rather than assuming any racket recording is correct. https://freesound.org/people/Breviceps/sounds/457039/

Selected assets will be downloaded, optimized, and accompanied by source/license notes. These are researched candidates, not already integrated assets.

## Validation and acceptance

Run the existing badminton simulation, keyboard/swipe, motion, and reaction checks affected by changes. Add focused behavioral checks for heat progression/reset, directional net impulses and damping, and celebration pivot restoration. Confirm local asset delivery and runtime loading. Inspect the real game and animation player for shader errors, texture orientation, clothing intersection, net response, and celebration continuity. Listen to the mixed audio at ordinary play intensity.

Compare steady-state CPU/GPU frame time and draw calls with the baseline at medium and high graphics; use frame-time percentiles rather than an average FPS claim. Performance acceptance: no unbounded allocations or voice growth, bounded simulation work per frame, and no sustained regression larger than 10 percent on the measured device without simplification. Zero lag on all hardware is not a measurable guarantee.

Implement in this order: assets and court; directional net; clothing; heat and fire; audio mix; banners and celebrations; integrated verification. The local game remains at http://localhost:3000/badminton.
