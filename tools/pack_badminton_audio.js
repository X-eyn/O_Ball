'use strict';
// Bundle short recordings as game data so browser download managers cannot capture playback fetches.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = path.join(__dirname, '..', 'public', 'badminton', 'assets');
// court-shoe takes by kind, as baked by tools/bake_badminton_steps.py (audio.js SHOE_KINDS)
const SHOE_KINDS = { tap: 8, step: 8, scuff: 6, squeak: 8, squeal: 6 };
const files = { racket: 'racket.mp3', applause: 'applause.mp3', rustle: 'rustle.mp3', ...Object.fromEntries(Object.entries(SHOE_KINDS).flatMap(([kind, n]) => Array.from({ length: n }, (_, i) => [`court_${kind}${i}`, `court-${kind}-${String(i + 1).padStart(2, '0')}.wav`]))) };
const bank = { version: 2, samples: Object.fromEntries(Object.entries(files).map(([name, file]) => {
  const bytes = fs.readFileSync(path.join(dir, file));
  return [name, { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') }];
})) };
fs.writeFileSync(path.join(dir, 'audio-bank.json'), JSON.stringify(bank));
console.log(`Packed ${Object.keys(files).length} recordings in one verified audio data bank (${fs.statSync(path.join(dir, 'audio-bank.json')).size} bytes).`);
