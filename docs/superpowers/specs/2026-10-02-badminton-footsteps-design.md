# Indoor court footsteps

Master requests real, pleasant footfalls rather than removing them. Restore movement sound with new indoor sneaker recordings, preserving the removal of the continuous crowd hiss.

Use eight short takes from sturmankin's CC0 low-sneaker recording on linoleum (Freesound 272516). Linoleum is a source proxy for the game's vinyl sports mat, not a claim of a badminton-court recording. Bake mono 48 kHz PCM takes offline: remove silence, attenuate harsh high frequencies and sub-bass, soften edges, match levels conservatively and limit peaks. Keep natural differences between takes; choose without immediate repeats. No synthetic noise substitute for missing shoe recordings.

Drive playback from rendered swing-to-plant foot transitions, not distance accumulated by a separate cadence clock. Suppress initial placement, teleports, airborne/dive/get-up states, pause, stalls and point celebrations. Keep the opponent quieter, retain camera-relative positioning, use little room sound and cap movement voices. Jump takeoff stays silent; hard landings use the same material palette.

Package every active recording once in a versioned, content-addressed JSON bank. Decode and cache on activation. Play AudioBufferSourceNode instances without media URLs, HTML audio elements or per-step network calls. Bank metadata includes exact byte length and SHA-256. Verify with native browser request/download instrumentation, repeated movement and mute/pause/room-exit checks; preserve the installed IDM settings.

Acceptance: real foot contacts trigger varied recorded takes, fixed bounds on voice count and level, no sounds at rest/air/pause, no recurring hiss, exactly one audio bank request and no browser media requests/download events during a movement run. Subjective ASMR satisfaction remains for Master's listening review; quantitative checks cannot certify it.
