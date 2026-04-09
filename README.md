# cmux Claude Sessions

Raycast extension to manage Claude Code sessions running in [cmux](https://cmux.com).

Send commands to idle Claude Code sessions directly from Raycast — no app switching needed.

## Features

- **Session list** — See all Claude Code sessions with their status (Idle / Permission / Working)
- **Quick send** — Type a command in the search bar and press Enter to send
- **Skill autocomplete** — Type `/` to browse available slash commands
- **Permission handling** — Approve or deny tool permissions with `Cmd+Y` / `Cmd+D`
- **Detail panel** — View Claude's last response in the right panel
- **Auto-refresh** — Session status updates every 3 seconds
- **Focus** — Jump to any session in cmux with `Cmd+O`

## Install

```bash
git clone <repo-url>
cd raycast-cmux-claude
npm install
npm run dev
```

## Setup

1. **cmux socket password** — Open cmux Settings or edit `~/.config/cmux/settings.json`:
   ```json
   {
     "automation": {
       "socketControlMode": "password",
       "socketPassword": "your-password"
     }
   }
   ```
   Reload config with `Cmd+Shift+,` in cmux.

2. **Raycast** — Open "Claude Sessions" in Raycast, enter your cmux password when prompted.

3. **Hotkey (recommended)** — Set a global hotkey (e.g. `Cmd+Shift+C`) in Raycast Extensions settings.

## Usage

1. `Cmd+Shift+C` (or your hotkey) — Open session list
2. Type command in search bar → press Enter on a session → sent
3. Type `/` to browse skills (e.g. `/commit`, `/pr`)
4. `Cmd+O` — Focus session in cmux
5. `Cmd+R` — Manual refresh

## Requirements

- [cmux](https://cmux.com) (macOS)
- [Raycast](https://raycast.com)
- Claude Code running in cmux

## License

MIT
