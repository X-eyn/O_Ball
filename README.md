# Office Ball ⚽

Fast 1v1 browser football for the office LAN. The winner stays on, and there's an ELO leaderboard.

## Office Badminton 🏸

The same server also serves a badminton game at **`/badminton`** (`http://<host>:3000/badminton`).
It has its own court, its own ELO table (`data/badminton.json`) and the same room flow: create a room,
send the invite link (`/badminton/r/CODE`), winner stays on, everyone else waits in line. Alone in a
room you get the practice bot.

- **First to 7**, rally scoring, on a court 1.35x the size of a real one (more room to move and to hit
  into). The shuttle's flight is scaled with it exactly and played at 85% of real speed, so every
  flight keeps its real shape with a little more time to read it (a smash arrives in ~0.47 s).
- **Reading the shuttle**: it always shows through players as a glowing ring (lime when it is coming
  at you), with a line down to its shadow for height. A ring closes on the landing spot as it comes
  down, the ring at your feet turns gold when it is in reach, and a red pulse under your opponent
  means they are winding up a smash: brace.
- **Shot**: hold and release (Space / click / A). Where you meet the shuttle picks the shot: overhead
  full charge is a **smash**, soft a **drop**; waist height a **drive**; low full charge a **clear**, soft a
  **net shot**; a full charge on a shuttle floating over the tape is a **kill**. Release on gold for a
  perfect strike.
- **Jump** (F / B / mouse thumb button): a short crouch, then up. A full-charge overhead met in the air is
  a **jump smash**: faster the higher you meet it, steeper, best at the top of the jump, and it lands you
  heavy. Jump out of a sprint for a long leap.
- **Defending a smash**: it is too fast to react to, so read the wind-up. Hold Shot to **brace** and
  release as it arrives to **counter** it flat into the open court (clean and on time: a **parry**); a late
  tap **blocks** it dead over the net; Lift sends it high.
- Big contacts carry weight: the whole game holds for a few frames of hit-stop, a smash that kills
  slams into the floor, and a match-winning slam plays back slow.
- **Movement**: a quick tap is a small step, a hold runs; stops are crisp (about 0.4 m from full speed).
  With nothing held, **placement assist** glides you the last metre or two to where the incoming shuttle
  is best met (any input takes over; turn it off under Menu > Settings). The camera frames you, the
  shuttle, where it is landing and your opponent, widening as the shuttle climbs.
- **Lift** (E / Y / Shift+click) sends it high. Hold **sprint** (Shift / X / right mouse button) for a
  faster stride that burns stamina; **double-tap** it to **dive**: a last-ditch launch of about 2 m along
  your run (bent toward a shuttle coming down just off the line) that strikes whatever it reaches, soft,
  and leaves you on the floor for two thirds of a second. Sprints, dives, jumps and smashes cost stamina.
- **Controls**: pick Keyboard, Mouse, Controller or Touch under Menu > Controls. The game never changes
  scheme by itself (a nudge of the mouse or a controller on the desk does nothing until you pick it).
- **Esc** opens the menu, and against the practice bot the match pauses until you close it.
- **Bot difficulty** (Menu > Settings): Easy, Normal, Hard or Pro. It is kept per player and applies
  to a practice match in play at once.
- The code is `shared/badminton.js` (rules and physics, server-side), `public/badminton/`
  (client, 3D hall, `anim.js` for the athletes, sounds) and `tools/badminton_test.js` (headless checks).

## Start it (host PC, once)

1. Double-click **`start.bat`**. It opens the game in your browser.
2. If Windows Firewall asks, click **Allow** (Private networks).
3. Enter your name, then click **Play**.
4. Click **Invite** (top right) and send the link to teammates (e.g. `http://192.168.1.23:3000/r/ABCD`).
   They paste it in their browser and they're in. Nothing to install.

Keep the black server window open while you play.

## Controls

Keyboard, mouse/trackpad and game controllers all work. The game switches to whichever you touch
(or pick one under **Menu > Controls**).

| Action | Keyboard | Mouse / trackpad | Controller |
|---|---|---|---|
| Move | `WASD` or arrows | player runs to the pointer | left stick / D-pad |
| Kick | hold & release `Space` / `J` | hold & release click | hold & release **A** (or RT) |
| Chip | hold & release `E` | shift+click or middle-click | **Y** |
| Tackle (fake while charging) | `Shift` / `K` | right-click (two-finger tap) | **X** / **B** / LB |
| Shield (hold) | `C` | `C` (or hold `C` while pointing) | hold **LT** |
| Knock on | `V` | `V` | **RB** |

- The ball is played by the **foot**: walking is close taps, a sprint is longer knocks you have to chase —
  so running with the ball is a risk. It is deterministic: the same touch always plays the ball the same
  way; a wrong-foot or pressured touch drifts exactly where you would expect it to.
  **Knock on** (`V` / RB / **Push**) deliberately pushes it three or four strides into space to chase;
  **Shield** (`C` / LT / **Shield**) slows you down, keeps the ball at your feet and holds a challenge off.
- One foot is stronger than the other (it comes from your name, like your player's look): touches and shots
  on the wrong side are looser and carry less. A ball dropping at chest height can be cushioned down;
  above head height it is headed — high balls go up and away, lower ones are driven at goal.
- An opponent pressing you spoils your first touch; winding up a shot leaves the ball open to a poke.

- Release while the ring is **gold** for a PERFECT shot: full power, and it goes exactly where you aim. A rushed or
  overcharged shot, or one struck at a flat-out sprint, strays a little. An arrow on the grass shows the aim.
- The ball goes where you're facing/pointing. Run one way and aim another to **curve** it.
- Ease off and the ball stays close to your feet; sprint and it runs away from you (and can be nicked).
- Tackle while you are charging a shot to cancel it: a shot fake.
- Released a bit early? The kick still fires when the ball reaches you.

| Other | Keys |
|---|---|
| Emotes | `1`–`6` |
| Mute | `M` |
| Menu (invite link, room, controls, settings) | `Esc` |

Graphics run on every PC, with or without a graphics card. **Auto** (the default) checks the machine and picks:

| Setting | For | What you get |
|---|---|---|
| High | a real graphics card | the full floodlit stadium: four-way floodlight shadows, reflections, HDR effects |
| Medium | laptop / integrated graphics | the same stadium with fewer shadows and lighter effects |
| Low | no graphics acceleration (VMs, remote desktops) | the same stadium, lightest settings |
| 2D | browsers with no 3D support | a 2D view of the same game |

Resolution adjusts itself during play to keep it smooth. If a PC still can't keep up, Auto drops one
setting between matches (never mid-match) and remembers it. Pick a setting yourself under
**Menu > Settings > Graphics** (the page reloads into it).

## Rules

- 2 minutes, first to 3 goals. If it's tied at the end, **sudden death**: the next goal wins.
- **Winner stays on.** Everyone else in the room waits in line. The loser goes to the back.
- Alone in a room? Pick in **Menu > Practice mode**: **Practice vs Bot**, or **Solo shooting** (no opponent, no clock,
  both goals count, `R` brings the ball to your feet). A ranked match starts the moment someone joins.
- Halftime at 1:00, and the teams switch ends for the second half.
- If someone disconnects mid-match, the game pauses for 12 s. If they don't return, it's a forfeit.
- Ranked results (ELO, W–L, head-to-head, streaks) are saved in `data/stats.json`.

## Playing on a phone

Open the same link on the phone (same Wi-Fi) and hold it sideways.

- **Left thumb:** put it down anywhere on the left half and steer. The stick appears where your thumb lands
  and follows it. It's analog: ease off to keep the ball close; at full tilt (the knob lights up) it runs away.
- **Right thumb:** **Shoot** (hold, release while it's gold for a perfect strike), **Tackle**, **Chip**,
  **Push** (knock the ball ahead) and **Shield** (hold, keeps it close). To fake a shot, slide your thumb
  from Shoot onto Tackle. The dark sweep on Tackle is its cooldown.
- The speech bubble at the top sends emotes. On Android, Play goes full screen and phones vibrate on
  kicks. On iPhone, use **Share > Add to Home Screen** for a full-screen game without Safari's bars.

## Loading and caching

- Everything loads **once**, behind the loading screen: code, fonts, player models, the stadium, both
  players, every shader and a first frame. After that, Play, Join, Practice and Leave switch views in the
  same page, so nothing is ever downloaded or built again during a visit.
- The loading screen counts real work: bytes against the exact total the server lists, build steps,
  and GPU programs compiled. The ring weights each stage by how long it took on that PC last time.
- Every game file has a URL that names its exact content, so browsers keep it for good and only re-fetch
  files that actually changed. Models, fonts and the fitted player kits are also kept in the browser's
  IndexedDB, so even a hard refresh (Ctrl+Shift+R) takes them from the PC instead of the network.
- Changed a file? Just reload: the page picks up the new version. An open tab left on an older build
  reloads itself into the new one.

## Troubleshooting

- **Teammates can't open the link:** they must be on the same network. On the host, make sure the
  Wi-Fi/Ethernet network is set to *Private* (Windows Settings → Network) and that Node.js is allowed
  through the firewall. If the host PC has several networks, **Menu > Invite** lists alternative addresses.
- **Port 3000 busy:** run `set PORT=3001 && node server.js`.
- **The game is slow or won't draw on someone's PC:** add `?gfx=2d` (or `lite`, `medium`, `high`) to the end of
  the link to force a graphics setting for that visit, e.g. `http://192.168.1.23:3000/r/ABCD?gfx=2d`.
- **After updating `server.js`, `assets.js` or `shared/game.js`, restart the server** (close the window and
  run `start.bat` again). The server runs the match rules, so rule changes only take effect after a restart.
  Changes to files in `public/` need only a reload.

## Credits

Player models, hairstyles and animations: [Quaternius](https://quaternius.com) (Universal Base Characters and
Universal Animation Library, CC0). `tools/prepare_players.py` turns the downloaded packs into `public/models/`.
