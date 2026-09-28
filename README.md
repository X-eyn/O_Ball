# Office Ball ⚽

Fast 1v1 browser football for the office LAN. The winner stays on, and there's an ELO leaderboard.

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

## Troubleshooting

- **Teammates can't open the link:** they must be on the same network. On the host, make sure the
  Wi-Fi/Ethernet network is set to *Private* (Windows Settings → Network) and that Node.js is allowed
  through the firewall. If the host PC has several networks, **Menu > Invite** lists alternative addresses.
- **Port 3000 busy:** run `set PORT=3001 && node server.js`.
- **The game is slow or won't draw on someone's PC:** add `?gfx=2d` (or `lite`, `medium`, `high`) to the end of
  the link to force a graphics setting for that visit, e.g. `http://192.168.1.23:3000/r/ABCD?gfx=2d`.
- **After updating the game files, restart the server** (close the window and run `start.bat` again). The
  server runs the match rules, so rule changes only take effect after a restart.

## Credits

Player models, hairstyles and animations: [Quaternius](https://quaternius.com) (Universal Base Characters and
Universal Animation Library, CC0). `tools/prepare_players.py` turns the downloaded packs into `public/models/`.
