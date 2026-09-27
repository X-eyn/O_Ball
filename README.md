# Office Ball âš½

Fast 1v1 browser football for the office LAN. The winner stays on, and there's an ELO leaderboard.

## Start it (host PC, once)

1. Double-click **`start.bat`**. It opens the game in your browser.
2. If Windows Firewall asks, click **Allow** (Private networks).
3. Enter your name, then click **Create room**.
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

- Release while the ring is **gold** for a PERFECT shot. An arrow on the grass shows where the kick will go.
- The ball goes where you're facing/pointing. Run one way and aim another to **curve** it.
- A slow ball sticks to your feet when you run into it. Only a tackle can take it off you.
- Released a bit early? The kick still fires when the ball reaches you.

| Other | Keys |
|---|---|
| Emotes | `1`â€“`6` |
| Mute | `M` |
| Menu (invite link, room, controls, settings) | `Esc` |

Graphics are 3D (three.js). **Menu > Settings > Graphics** switches Auto / High / Low. Auto steps down
on slow laptops.

## Rules

- 2 minutes, first to 3 goals. If it's tied at the end, **sudden death**: the next goal wins.
- **Winner stays on.** Everyone else in the room waits in line. The loser goes to the back.
- Alone in a room? Pick in **Menu > Practice mode**: **Practice vs Bot**, or **Solo shooting** (no opponent, no clock,
  both goals count, `R` brings the ball to your feet). A ranked match starts the moment someone joins.
- Halftime at 1:00, and the teams switch ends for the second half.
- If someone disconnects mid-match, the game pauses for 12 s. If they don't return, it's a forfeit.
- Ranked results (ELO, Wâ€“L, head-to-head, streaks) are saved in `data/stats.json`.

## Troubleshooting

- **Teammates can't open the link:** they must be on the same network. On the host, make sure the
  Wi-Fi/Ethernet network is set to *Private* (Windows Settings â†’ Network) and that Node.js is allowed
  through the firewall. If the host PC has several networks, the sidebar lists alternative addresses.
- **Port 3000 busy:** run `set PORT=3001 && node server.js`.
