# Changelog

Container images are built from every push to `main` as `ghcr.io/vitafortis/octo-modern:0.1.<build>` (the GitHub Actions run number, also shown in the sidebar) and `:latest`; release tags `v*` add `:X.Y.Z`, `:X.Y` and `:X`. The Android app is released separately under `android-v*` tags. See [Images](README.md#images).

## Unreleased (`main`, images `0.1.<build>` after 0.1.0)

### Printers
- **Klipper (Moonraker)** printers next to OctoPrint ones, behind a printer backend interface: live status over Moonraker's websocket, jobs, files with slicer thumbnails, controls and macros, the terminal, webcams, history (with Moonraker's job history imported), the queue, notifications, smart plugs and spools. Auto-detect in the add-printer dialog, `_moonraker._tcp` in Discover.
- **Plugins & updates** (Care tab, admins, OctoPrint): OctoPrint's version and update, plugin updates and **Update all**, installed plugins (enable, disable, uninstall), the plugin repository with one-click install, live logs, restart OctoPrint, and an `octoprint.updates` notification.
- **Bed mesh** (Care tab) for printers with the Bed Visualizer plugin: heatmap and 3D surface, probing from octo·modern, mesh history and comparison, `bed.drift` alerts.
- **Before each print**: optional bed leveling and pre-print G-code before every print octo·modern starts, skipped when the file already does it, with a **Preparing** state and `print.prestart_failed`.
- **Smart plugs**: Shelly (Gen1, Gen2+), Tasmota, Home Assistant and HTTP switches, auto power-on for prints and the queue, auto power-off after a cooled-down print (survives restarts).
- **Failure detection** with a self-hosted Obico ML API: Obico's scoring, warnings with the annotated frame, optional pause; state survives restarts.

### Prints and planning
- **Print queue** for every printer with tags, copies, bed-clear confirmation and a filament check, plus **slicer uploads** (PrusaSlicer, OrcaSlicer, Cura) through an OctoPrint-compatible API with per-key destinations.
- **Spoolman** spools per extruder, usage reporting, low-spool warnings; **cost per print**; **maintenance reminders**.
- **Stats** (History → Stats): print hours, outcomes, filament, cost, most-printed files, failure reasons and utilisation, with CSV.
- **G-code preview** (3D and layers, live during a print, 100 MB files) and the **camera wall** with kiosk mode.

### Integrations
- **MCP server for Claude and other AI tools** at `/mcp` (Streamable HTTP, stateless, official MCP SDK): read tools (printers, status, camera snapshot, files and library, queue, history, stats, maintenance, updates, filament) and, for control tokens, pause/resume/cancel/start, add to queue, confirm a bed clear and set temperatures. `ocx_` tokens from **Settings → Integrations → MCP server** (admins), read-only or control, all or chosen printers, with copy-paste setup for Claude Code and Claude Desktop; each acts as its creator and never exceeds their current access. Cancel and start need `confirm: true` and go through the same checks as the UI; every action is audit-logged `via MCP token “Name”`.

### Notifications and apps
- **Notifications** rebuilt as a module: ntfy, Discord, Slack, Telegram, Pushover, Gotify, Matrix, email, Home Assistant, webhooks and **browser push**, with rules, quiet hours, de-duplication and a delivery log.
- **Installable web app** (manifest, service worker, offline page, Install app button).
- **Android app** ([android-v0.1.0](https://github.com/vitafortis/octo-modern/releases/tag/android-v0.1.0)): the web UI in an app with live progress notifications (Pause/Resume/Cancel), a home-screen widget and an app lock, using per-device tokens.

### Layout
- **Phones and tablets**: drawer and top bar, sheets, thumb-sized controls.
- **Simpler navigation**: sidebar with Overview, Queue, Library, History, Cameras and the printers; one Settings area (General, Printers & Discover, Users, Notifications, Integrations, Audit log); six printer tabs (Dashboard, Files, Control, Camera, Jobs, Care). Old `?tab=` links still work.

## 0.1.0 (2026-10-10, tag `v0.1.0`, images `0.1.0` and `0.1`)

- Multi-printer OctoPrint UI: overview, dashboard with live temperatures, jobs with confirmations, files with streamed uploads, Control and Terminal tabs, webcams relayed through the server.
- One push connection per watched printer, fanned out over Server-Sent Events; light polling otherwise.
- Encrypted store (AES-256-GCM) with API keys that never reach the browser; users with admin, operator and viewer roles and per-printer access; optional sign-in with guests; OIDC single sign-on; audit log; status API tokens for dashboards; encrypted backup and restore.
- **Discover**: OctoPrint in Docker (through a read-only socket proxy), Arcane, mDNS and subnet scans, added through OctoPrint's Application Keys flow.
- **Library**: print from a NAS (folder, SMB, SFTP, WebDAV) with slicer metadata and thumbnails.
- **Print history** recorded server-side, with import of earlier prints, and **timelapses** in the browser.
- First print notifications (ntfy, Discord, webhooks).
- Multi-arch Docker image (`amd64`, `arm64`), compose file, Apache-2.0 license.
