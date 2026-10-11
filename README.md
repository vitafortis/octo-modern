<p align="center">
  <img src="docs/logo.svg" width="64" height="64" alt="" />
</p>

<h1 align="center">octo·modern</h1>

<p align="center">
  A modern, self-hosted web UI for one or more OctoPrint servers.<br />
  Live state, webcams, files and jobs for every printer in one place, with the API keys kept on the server.
</p>

<p align="center"><a href="https://vitafortis.github.io/octo-modern/"><b>Website</b></a> · <a href="https://vitafortis.github.io/octo-modern/docs.html">Docs</a></p>

<p align="center">
  <img src="docs/screenshots/overview.png" alt="octo·modern overview" />
</p>

## Features

- **Every printer in one place**: add any number of OctoPrint servers. The sidebar shows each one's state (ready, printing, paused, error, unreachable) and progress; the overview shows the current file, progress, time left, ETA, temperatures and a webcam snapshot per printer. With a single printer, octo·modern opens straight to it.
- **Live, without hammering OctoPrint**: while you watch a printer, octo·modern keeps one push connection to OctoPrint (its SockJS websocket) and fans updates out to every browser over Server-Sent Events. Printers nobody is watching get a light status poll. If the websocket can't connect (a proxy without websocket support, say), it polls instead and keeps retrying with backoff.
- **Temperatures**: a live chart of actual and target temperatures per hotend, bed and chamber (5, 15 or 30 minutes), set targets directly or from OctoPrint's temperature presets, and turn everything off at once.
- **Jobs**: print, pause, resume, restart and cancel. Cancelling always asks first, from the dashboard, the printer header or the overview card.
- **Files**: browse OctoPrint's storage and the SD card with folders, sizes, upload dates, estimated print time, filament and the last print's outcome (and slicer thumbnails, if a thumbnail plugin provides them). Search and sort, drag and drop G-code to upload with progress, "print after upload", print or load any file, create folders, and delete (with confirmation). Uploads stream through octo·modern to OctoPrint without being held in memory, so files of hundreds of megabytes are fine.
- **Library**: print G-code straight from your NAS (a mounted NFS/SMB share, SMB, SFTP or WebDAV). Browse and search it with slicer thumbnails, print time and filament read from each file, then send it to any printer, or send and print, streamed without a copy in between. See [Library](#library-print-from-your-nas).
- **Print queue**: one queue for every printer. Add jobs from the library, a printer's files or an upload, for a specific printer or "any compatible printer" (free-form tags such as `0.4mm`, `petg`); drag or use the arrows to reorder, set copies, pause. A printer takes the next job when it's idle and someone has confirmed its **bed is clear**, which it asks for after every print (with a notification); a failed or cancelled queued print pauses that printer. See [Print queue](#print-queue).
- **Slicer uploads**: PrusaSlicer, OrcaSlicer and Cura can send G-code to octo·modern as if it were an OctoPrint server, with an upload key that decides where it goes: the queue, a library folder, or one printer. See [Slicer uploads](#slicer-uploads).
- **G-code preview**: see a file's toolpath before you print it, in 3D (orbit, pan, pinch) or layer by layer from above, with a layer slider, travel moves on or off and colours by feature type (walls, infill, supports… from PrusaSlicer, OrcaSlicer, Bambu Studio and Cura comments). Works for files on a printer and in the library; during a print it follows the job live, marking what's printed and where the nozzle is. Files of 100 MB and more stream in and are parsed in the background. See [G-code preview](#g-code-preview).
- **Camera wall**: every webcam you may see on one page, with each printer's state, progress and temperatures on top; tap one for full screen. A **kiosk** mode for a wall tablet or TV hides everything else, hides the cursor, keeps the screen on and can rotate through the cameras; many cameras switch to snapshots to save bandwidth. Bookmarkable. See [Camera wall](#camera-wall).
- **Webcams**: the live MJPEG stream on the dashboard (with fullscreen) and its own tab, relayed by octo·modern so it works wherever octo·modern does, even when the camera is on a LAN address the browser can't reach. Several cameras per printer get a switcher; flip and rotation follow OctoPrint's settings; HLS and WebRTC cameras get an "Open stream" link.
- **Control**: jog X/Y/Z in 0.1–100 mm steps (buttons or arrow keys, Page Up/Down and Home while the pad has focus), home, motors off, feed and flow rate overrides, part fan, extrude/retract and tool select. It follows the printer profile (axis inversion, build volume, extruder count, heated bed/chamber) and shows OctoPrint's custom controls (sections, commands, scripts, sliders and inputs, feedback lines). Movement is refused while a print runs, by the server too; jogs are coalesced in the audit log.
- **Terminal**: the live serial log (virtualized, follows the bottom until you scroll up), filters for temperature reports, `ok`, SD status, `wait` and `busy`, search with highlighting, clear and copy. A G-code prompt with multi-line send, history (↑/↓, kept per user and printer), autocomplete with short descriptions, optional uppercasing, and an emergency stop button.
- **Discover**: find OctoPrint in Docker (through a read-only socket proxy), in [Arcane](https://getarcane.app), over mDNS and with a subnet scan, see which serial port each container owns, and add one by approving octo·modern in OctoPrint (Application Keys), no key to copy. See [Discover](#discover).
- **Print history**: every print on every printer, recorded whether or not anyone has a browser open: file, start and end, duration, result (success, failed, cancelled), filament used, who started it, a webcam picture of how it ended, and notes. A History tab per printer and a History page across all of them, with filters, success rate, print time and filament per printer and per week, CSV export, and "print again". Earlier prints are imported from OctoPrint. See [Print history](#print-history).
- **Stats**: print hours per day, week or month stacked by printer, outcomes over time, success rate, filament (m and g, per material and per Spoolman spool), cost, most-printed files, why prints failed and how busy each printer was, over 30 days, 90 days, 12 months or all time, in your own time zone, with a CSV of the prints behind it. See [Stats](#stats).
- **Timelapses**: watch OctoPrint's timelapses in the browser (with seeking), download and delete them, render unrendered ones, and change the timelapse settings.
- **Notifications** to ntfy, Discord, Slack, Telegram, Pushover, Gotify, Matrix, email (SMTP), Home Assistant or any webhook, with the webcam snapshot: prints started, at milestones, paused (filament runout, M600, a pause in the G-code, or who), finished, failed, cancelled (and by whom); printers offline, in error, back, or still hot after a print; plus the queue, failure detection and other features. Rules per printer and event, quiet hours per channel, de-duplication and a delivery log. See [Notifications](#notifications).
- **Smart plug power**: switch each printer with a Shelly (Gen1 and Gen2+), Tasmota, Home Assistant or any HTTP switch, from the printer page, its overview card or a right-click in the sidebar, with the plug's watts and energy where it measures them. After power-on octo·modern connects the printer; after a print it can turn it off once the hotend has cooled; and it can switch a printer on when a print is sent to it. Turning off asks first while the printer is hot, and twice while it prints. See [Smart plugs](#smart-plugs).
- **Spoolman**: pick the active [Spoolman](https://github.com/Donkie/Spoolman) spool per printer and extruder (search, colour, material, what's left), see it on the dashboard, and have each print's filament reported to Spoolman as it prints and when it ends. Before a print starts, octo·modern warns when the spool won't last. See [Spools, costs and maintenance](#spools-costs-and-maintenance).
- **Cost per print**: filament (by the spool's price from Spoolman, or a price per kg per material) plus electricity (print time × each printer's power draw), on every history entry, in the History stats per printer and in the CSV export; earlier prints are costed too.
- **Maintenance reminders**: per-printer tasks counted in print hours, filament used or days (nozzle, belts, rails, bed, e-steps offered), with due/overdue badges, "Done" with notes and a log of who did what when.
- **Bed mesh**: for printers with the [Bed Visualizer](https://github.com/jneilliii/OctoPrint-BedLevelVisualizer) plugin, a **Bed** tab with the mesh as a heatmap with values and a 3D surface you can rotate and zoom, its range, lowest and highest points and flatness; **Update mesh** probes the bed from octo·modern. Every mesh is kept, so you can compare any two (a difference map) and follow flatness over time, and a `bed.drift` notification tells you when the bed warps past your limits. See [Bed mesh](#bed-mesh).
- **Connection**: connect and disconnect the printer with OctoPrint's ports, baud rates and printer profiles, and an emergency stop (M112).
- **API keys stay server-side**: keys are sealed with AES-256-GCM and never sent to a browser. Every request to OctoPrint, including the push connection, webcam images and uploads, goes through octo·modern.
- **Roles**: *admins* manage everything, *operators* run printers, *viewers* watch. Give people every printer or only some. See [Users and roles](#users-and-roles).
- **AI failure detection**: while a printer prints, webcam frames go to your own [Obico](https://www.obico.io) ML container; a smoothed failure score (Obico's own algorithm) warns you with the annotated frame and can pause a print that has turned to spaghetti. A "false alarm" button quiets it for the rest of the print. See [Failure detection](#failure-detection).
- **Audit log**: every print started, paused or cancelled, every temperature change, upload, deletion, G-code command and connection change, with who did it and from where.
- **Single sign-on**: any OIDC provider (Authentik, Authelia, Keycloak, Pocket ID, Google, …), with accounts created automatically for matching emails.
- **Status API for dashboards**: read-only tokens for Homepage, Glance, Uptime Kuma and Home Assistant. See [Dashboards and monitoring](#dashboards-and-monitoring).
- **Backup & restore**: an encrypted, passphrase-protected file with your printers (and their API keys), users, settings, notification channels and the print queue, optionally the print history (with or without its pictures), that restores on a fresh install.
- **Command palette**: `⌘K` (`Ctrl+K` on Linux/Windows) jumps to printers, tabs and pages.
- **Phones and tablets**: below laptop width the sidebar becomes a drawer behind a slim top bar (with the printer's state and a search button), tables become lists with each row's actions in a menu, and dialogs slide up as sheets. On a phone, Pause, Cancel and the emergency stop (which still asks first) sit in a bar under your thumb; the jog pad is thumb-sized, the webcam goes fullscreen with a tap, the temperature chart reads out where you touch, and the terminal prompt stays just above the keyboard. Buttons and fields are at least 44 px on touch screens, with 16 px text so iOS doesn't zoom.
- **Add to Home Screen**: a web app manifest, home-screen icons and a status bar that follows the theme, so octo·modern opens full screen like an app (`display: standalone`, notch-aware).
- **Light and dark** themes, and multi-arch images (`amd64`, `arm64`).

## Getting started

### Docker Compose (recommended)

```sh
mkdir octo-modern && cd octo-modern
curl -fsSLO https://raw.githubusercontent.com/vitafortis/octo-modern/main/compose.yaml
docker compose up -d
```

Open `http://<your-host>:3040`. A short setup wizard creates the admin account (name, email, password) and adds your first printer.

### `docker run`

```sh
docker run -d --name octo-modern \
  -p 3040:3000 \
  -v octo-modern-data:/data \
  --add-host host.docker.internal:host-gateway \
  ghcr.io/vitafortis/octo-modern:latest
```

The container runs as an unprivileged user and needs nothing but its `/data` volume. It never needs the Docker socket itself; [Discover](#discover) can read containers through an optional read-only socket proxy.

### Using Arcane?

Add `compose.yaml` as a new project in [Arcane](https://getarcane.app) and deploy it. Everything octo·modern stores lives in the `octo-modern-data` volume.

### Adding a printer

You need two things from each OctoPrint:

1. **Its URL, as octo·modern's server reaches it.** Usually `http://<pi-ip>` or `http://octopi.lan`. Behind a reverse proxy at a path, include the path (`https://print.example.com/octoprint`). Inside Docker, `localhost` is octo·modern's own container: use the host's IP, or `host.docker.internal` for an OctoPrint on the same Docker host. `.local` (mDNS) names usually don't resolve inside containers.
2. **An API key.** In OctoPrint, open **Settings → Application Keys** and generate one named "octo·modern", or copy a user's key from **User Settings → API key**. The key acts with the permissions of the OctoPrint user it belongs to, so a key of an admin user allows everything octo·modern does.

**Test connection** shows OctoPrint's version, which user the key belongs to, and any permission the key lacks. Self-signed certificate on your LAN? Turn off **Verify TLS certificate** for that server.

Or let octo·modern find it: the setup wizard lists OctoPrint servers it finds in Docker and over mDNS right after you create the admin, and **Discover** (in the sidebar) does the rest. You approve the key in OctoPrint instead of copying it.

## Discover

**Discover** (admins) finds OctoPrint servers and adds them in two clicks.

![Discover](docs/screenshots/discover.png)

It looks in three places, one tab each:

- **Docker**: every container on each Docker endpoint. OctoPrint is recognized by image (`octoprint/octoprint`, `linuxserver/octoprint`, anything named `…/octoprint`), or by port 80/5000 plus OctoPrint environment variables, labels or container name; exporters, Obico and other companions are skipped. Each candidate shows its image, compose project, the **serial devices** mapped into it (`--device /dev/ttyACM0`, a bind-mounted `/dev/serial/by-id/…`, or a privileged container with `/dev`), so you can tell which printer it drives, and how octo·modern reaches it.
- **Arcane**: the same, for every environment an [Arcane](https://getarcane.app) instance manages, through its API.
- **Network**: mDNS (OctoPrint announces `_octoprint._tcp`) and a subnet scan, for OctoPi on a Raspberry Pi and anything else outside Docker.

**Reaching it.** A container may be reachable on a published port, on its IP on a Docker network, by container name, or on the host network. Discover probes every address it knows and preselects the first that answers as OctoPrint; the others stay in the address menu. It also shows which networks the container is on, which of them octo·modern shares, and for a container octo·modern can't reach, the compose change that attaches octo·modern to the right network (or the port to publish). octo·modern finds its own container by hostname or IP; set `OCM_SELF_CONTAINER` if you gave it a custom hostname.

**Recognizing OctoPrint without a key.** Since 1.5, OctoPrint answers its API with 403 until you log in, so Discover looks for markers only OctoPrint has: `GET /plugin/appkeys/probe` answers 204 (the bundled Application Keys plugin), `GET /` redirects to `/login/?redirect=…&permissions=…`, and the login page is titled "OctoPrint". The version comes from the mDNS record, the container image (`octoprint_ref`), or `/api/version` when anonymous access is allowed; with a key, **Test connection** always shows it.

**Adding one.** **Add** opens a dialog that asks OctoPrint for an [Application Key](https://docs.octoprint.org/en/master/bundledplugins/appkeys.html): **Approve in OctoPrint** opens OctoPrint's own approval page (and OctoPrint admins who are signed in get a prompt too). Sign in there as the user whose permissions the key should have and click **Allow**. octo·modern picks the key up within a second, tests it and saves the printer. The key goes from OctoPrint to octo·modern's server and into the encrypted store; the browser never sees it. Prefer to paste a key? **Paste a key** does that. A key that fails the test isn't saved unless you say so.

OctoPrint allows 3 key requests a minute, and drops a request nobody approves within 10 minutes (octo·modern stops waiting after 5).

**Saved and moved printers.** Candidates that are already saved say so, matched by any of their addresses or by the container (or mDNS name) they were added from. When a saved container shows up at a new address (a new published port, a moved container), Discover flags it and **Use … → printer** points the saved printer at the new address, keeping its key, name and settings.

![Discover: an address changed](docs/screenshots/discover-moved.png)

### Docker, through a read-only socket proxy

octo·modern only lists and inspects containers (`GET /containers/json` and `GET /containers/{id}/json`), so don't give it the raw socket. Run [tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) next to it with `CONTAINERS=1` and `POST=0` and point `OCM_DOCKER_HOSTS` at it. The commented `docker-proxy` service in [`compose.yaml`](compose.yaml) is ready to uncomment:

```yaml
services:
  octo-modern:
    environment:
      OCM_DOCKER_HOSTS: tcp://docker-proxy:2375
    depends_on: [docker-proxy]
  docker-proxy:
    image: tecnativa/docker-socket-proxy:latest
    restart: unless-stopped
    environment:
      CONTAINERS: 1
      POST: 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

More Docker hosts? Run a proxy on each and list them all: `OCM_DOCKER_HOSTS=tcp://docker-proxy:2375,tcp://nas.lan:2375`, or add them under **Discover → Docker → Docker endpoints**. Published ports are reached through the endpoint's host (`host.docker.internal` for the local socket).

### Arcane, with a read-only key

In Arcane, open **Settings → API Keys** and create a key with only read permissions: `environments:list`, `containers:list` and `containers:read` are what octo·modern uses (`projects:list` and `projects:read` don't hurt, so pg·modern's key works too). Then connect it under **Discover → Arcane**, or set `OCM_ARCANE_URL` and `OCM_ARCANE_API_KEY`. The key is stored encrypted. Published ports resolve to each environment's host address.

### mDNS needs the LAN

OctoPi announces itself over mDNS (`_octoprint._tcp.local`, with its version and model). octo·modern sends a plain DNS-SD query, no Avahi or extra packages needed, but multicast only reaches one network segment: inside Docker's default bridge network, nothing answers. To use it, run octo·modern with `network_mode: host`, or attach it to a macvlan/ipvlan network on your LAN. On a bridge network, use the subnet scan instead. (OctoPi advertises OctoPrint's own port 5000, which only listens on the Pi itself; Discover also tries 80 and 443, where OctoPi's proxy serves it.)

### Subnet scan

Enter a CIDR (`192.168.4.0/24`), a range (`192.168.4.20-40`) or addresses, and ports (default `80, 5000, 443`). octo·modern opens TCP connections (128 at a time, 0.7 s timeout) and fingerprints whatever answers, without a key. Ports 80 and 443 of one host count as one server; any other port is listed separately, so several OctoPrint instances on one Pi each show up. Scans are limited to 4096 addresses, only admins can start one, and each is recorded in the audit log.

![Discover: network](docs/screenshots/discover-network.png)

## Users and roles

| | Admin | Operator | Viewer |
| --- | --- | --- | --- |
| Watch printers: state, temperatures, webcam, files | ✓ | ✓ | ✓ |
| G-code preview (printer and library files), camera wall | ✓ | ✓ | ✓ |
| Start, pause, resume, cancel prints | ✓ | ✓ | |
| Set temperatures, connect/disconnect, G-code, emergency stop | ✓ | ✓ | |
| Power printers on and off (smart plug), "Keep on" | ✓ | ✓ | |
| Upload, print and delete files | ✓ | ✓ | |
| Browse the library | ✓ | ✓ | ✓ |
| Send library files to printers, save printer files to the library | ✓ | ✓ | |
| Watch the print queue | ✓ | ✓ | ✓ |
| Add, reorder and remove queued jobs, pause the queue, confirm a bed is clear | ✓ | ✓ | |
| Printer tags (for the queue), slicer upload keys | ✓ | | |
| Watch the print history, Stats and timelapses, export CSV | ✓ | ✓ | ✓ |
| Notes on prints, print again, delete and render timelapses | ✓ | ✓ | |
| Watch failure detection (score, last frame) | ✓ | ✓ | ✓ |
| Turn failure detection on/off per printer, its sensitivity and action; mark a false alarm | ✓ | ✓ | |
| See spools, print costs and maintenance tasks | ✓ | ✓ | ✓ |
| Choose a printer's active spool; add, edit and complete maintenance tasks | ✓ | ✓ | |
| See bed meshes, their history, comparisons and drift settings | ✓ | ✓ | ✓ |
| Update the bed mesh (probe), drift alerts and reference mesh, delete meshes | ✓ | ✓ | |
| Spoolman connection, cost settings | ✓ | | |
| Timelapse settings, delete history entries, import history | ✓ | | |
| Notifications: channels, rules, quiet hours, delivery log | ✓ | | |
| Set up smart plugs and their automations, test them | ✓ | | |
| Add, edit and remove printers (and their API keys) | ✓ | | |
| Users, Integrations, Audit log, Settings (including the ML API), backups, library sources | ✓ | | |

Operators and viewers see every printer, or only the ones you pick under **Users → Printers**. Printers someone hasn't been given don't exist as far as they can tell. Roles are enforced on the server for every route, not just hidden in the UI.

Dangerous actions ask for confirmation, and the server insists on it too (it answers `409` with `confirmRequired` until the request says `confirm: true`): cancelling a print, deleting a file, an emergency stop (M112), disconnecting during a print, sending G-code while printing, and G-code that stops the machine or touches stored settings and firmware (M0/M1, M81, M92, M112, M302, M303, M410, M500–M502, M906/M907, M997, M999).

The first admin is created by the setup wizard, or headlessly with `OCM_ADMIN_EMAIL` and `OCM_ADMIN_PASSWORD`. Everyone can change their name, email and password under **My account** (click your name in the sidebar).

### Printer access vs. sign-in

These are two separate layers:

- **octo·modern → OctoPrint**: each printer's API key is saved (encrypted) in `/data`, so octo·modern stays connected, keeps watching temperatures and jobs, and survives restarts whether or not anyone is signed in. Nobody using octo·modern needs an OctoPrint login.
- **You → octo·modern**: octo·modern's own accounts and roles (above). Under **Settings → Sign-in** you can make sign-in optional: visitors then use it as guests who can either watch or control printers, while admin pages still need an admin account. `OCM_AUTH=disabled` goes further and gives everyone full access (trusted networks only).

### OIDC

Set up single sign-on under **Integrations**, or with `OCM_OIDC_*` variables (see [Configuration](#configuration)). Register `<your-url>/auth/oidc/callback` as the redirect URI with your provider. People whose email matches **Create accounts automatically for** get an account on first sign-in, as admin if they also match **…as admin when matching**, otherwise with the default role (viewer, unless you choose operator). Once SSO works you can turn off password sign-in; `OCM_LOCAL_LOGIN=enabled` brings it back if SSO breaks.

## Webcams

octo·modern reads each printer's cameras from OctoPrint's webcam settings: the classic webcam and any camera a webcam plugin adds. Relative URLs like `/webcam/?action=stream` are resolved against the OctoPrint URL. To use a different camera, put its stream or snapshot URL in the server's **Webcam** field; it wins over OctoPrint's settings.

- **MJPEG** streams (mjpg-streamer, ustreamer, camera-streamer's MJPEG endpoint) are relayed through octo·modern, with snapshots for the overview cards. The relay applies backpressure and closes the camera connection as soon as the last viewer leaves; streams pause while the page is hidden.
- **HLS and WebRTC** streams can't be relayed as an image; octo·modern shows a snapshot (if there is one) and an **Open stream** link, which the browser must be able to reach.

## Camera wall

**Cameras** (in the sidebar) shows every camera of every printer you may see: one column on a phone, as many as fit on wider screens (or 1–4 columns). Each tile has the printer's name and state, the job's progress and time left, and the temperatures. Tap a tile for full screen (← → switch cameras, Esc closes).

- **Live or snapshots.** *Auto* streams live up to four cameras and switches to snapshots, refreshed every few seconds, for more. Each MJPEG stream keeps a connection open and browsers allow only six per host over HTTP/1.1, so a wall of live streams would also block the rest of the page. Pick *Live* or *Snapshots* to override. Cameras pause while they're scrolled out of view, while the tab is hidden, and while another camera is open full screen. A stream that breaks falls back to snapshots and tries again a minute later.
- **Kiosk** turns the page into a full-screen wall for a tablet or a TV: no sidebar, the cursor hides after 3 seconds, the screen is kept awake (Screen Wake Lock API, where the browser has it), and optionally one camera at a time, rotating every N seconds. Move the mouse or tap for **Exit kiosk**, or press Esc.
- **Bookmarkable**: the options are in the URL, e.g. `/cameras?kiosk=1&layout=3&mode=snapshot&every=5&rotate=20&printers=<id>,<id>&fill=1`. `layout` is `1`–`4` columns, `mode` `live` or `snapshot`, `every` the snapshot interval in seconds, `rotate` seconds per camera in kiosk mode, `printers` limits the wall to some printers, `fill` crops pictures to fill their tiles. For a wall tablet, sign in once (or allow guests to watch under **Settings → Sign-in**) and open that URL as a home-screen app.

## G-code preview

The **Preview** tab on a printer shows the job's toolpath; the cube button next to a file (in **Files** and in the **Library**) previews any other one. Drag to orbit (right-drag or Shift to pan), scroll or pinch to zoom, double-click or double-tap to reset; the slider and ↑/↓ (Page Up/Down, Home/End) change the layer. **Layer** switches to a top-down view of one layer over a faint copy of the one below. **Travel** shows moves without extrusion; the legend hides and shows feature types.

- **Live**: while the file prints, the preview follows OctoPrint's position in the file (`progress.filepos`, from the live updates the page already gets): the layer being printed, what's done (solid) and what's left (a faint ghost, toggle **Remaining**), and a dot at the nozzle. Moving the slider stops following; **Follow** resumes.
- **What's understood**: `G0`/`G1`, arcs (`G2`/`G3` with `I`/`J` or `R`), absolute and relative positioning (`G90`/`G91`) and extrusion (`M82`/`M83`), `G92`, `G28`, inches (`G20`). Layers come from the slicer's comments (`;LAYER_CHANGE`, `;LAYER:n`, Bambu's `; CHANGE_LAYER`) or, without them, from the height of the extrusions. Feature colours come from `;TYPE:` / `; FEATURE:` comments. Binary G-code (`.bgcode`) and SD card files can't be previewed.
- **Big files**: the file is downloaded through octo·modern in 16 MB ranges (a dropped connection resumes where it stopped) and parsed in a Web Worker as it arrives, into compact typed arrays: about 17 bytes per move. Consecutive travels merge, and past a point budget (3 million moves on computers, 1.5 million on phones and small-memory devices) short segments are merged into longer ones, so memory stays bounded; the preview then says **Simplified**. Drawing is capped too: beyond 2 million segments per frame (600,000 on phones), the lower layers are drawn coarser, and coarser still while you move the view. A 100 MB file (3.6 million moves) loads in about a second from a local library; see [Development](#development) for numbers.
- **Access**: anyone who can see a printer (or a library source) can preview its files, viewers included. The file is fetched by the server with the printer's API key (or the source's credentials), which never reach the browser: `GET /api/printers/<id>/files/download?path=…` and `GET /api/library/<source>/download?path=…`, both with HTTP Range support.

## Files and uploads

The **Files** tab lists OctoPrint's local storage and, when the printer has one, its SD card. Uploads go to local storage (OctoPrint can copy files to the SD card itself). The upload is streamed to OctoPrint as it arrives, so octo·modern's memory use doesn't grow with the file; the image allows uploads up to 4 GB (`BODY_SIZE_LIMIT`). A reverse proxy in front of octo·modern may have its own limit (nginx: `client_max_body_size`).

## Library (print from your NAS)

<p align="center"><img src="docs/screenshots/library.png" alt="The Library" /></p>

The **Library** (in the sidebar, for everyone) shows the G-code your slicer saved on your NAS, so you don't have to upload it to each printer first. Pick a file, see its preview, print time, filament, layer height, nozzle and temperatures, and **Send** it to a printer or **Send & print**. Each printer's **Files** tab has a **From library** button that does the same into the folder you're looking at.

- **Sources** (admins, **Library → Sources**) say where the files are. There can be several; each can be limited to some printers.

  | Type | For | Notes |
  | --- | --- | --- |
  | **Folder** | A path inside the container, typically an NFS or SMB share mounted as a Docker volume | The recommended NAS route; nothing to install on the NAS, and the fastest |
  | **SMB share** | Windows, Synology, TrueNAS, Unraid, Samba | SMB 2.1/3 directly, no mount needed. User and password (NTLMv2); no guest access or Kerberos |
  | **SFTP** | Any SSH server | Password or private key. **Test** shows the server's host key; pin it to refuse anything else |
  | **WebDAV** | Nextcloud, ownCloud, Synology WebDAV Server, rclone | A folder URL, user and password (an app password for Nextcloud) |

  **Test** connects and lists the top folder. Passwords and keys are encrypted like printer API keys and never sent to a browser; people who aren't admins don't see addresses or user names either.
- **Read-only by default.** octo·modern never writes to a source unless you turn on **Allow writing**, which enables **Save to library** on a printer's files (OctoPrint → NAS).
- **Browsing**: folders, search through subfolders (it stops after 300 matches, 3,000 folders or 15 seconds, and says so), sort by name, date or size. Only printable files (`.gcode`, `.gco`, `.g`, `.gc`, `.bgcode`, `.ufp`) are shown unless you flip **All files**; NAS clutter like `@eaDir`, `#recycle` and dotfiles is always hidden.
- **Slicer details** come from the comments at the top and bottom of each file (PrusaSlicer, SuperSlicer, OrcaSlicer/Bambu Studio, Cura, and Prusa's binary `.bgcode`), including the embedded thumbnail (PNG, JPG or QOI). Only the first 64 KB and last 128 KB are read (a bit more if a big thumbnail runs past that), and the result is cached until the file's size or date changes.
- **Sending** streams the file from the NAS into OctoPrint's upload as it's read, so a 150 MB file costs octo·modern no more memory than a small one. You choose the printer (with one printer, it's preselected), the folder on OctoPrint and whether to start printing; a progress bar follows the transfer, which keeps going if you close the dialog. If the printer already has a file with that name you're asked before it's replaced, and if it's busy printing, **Send & print** asks whether to just send it. Every send is in the audit log (`library.send`, with source, path and printer).
- **Folder paths are contained**: paths with `..` are refused, and symlinks that lead out of the source's folder are neither listed nor followed.

### Mounting a NAS share

Let Docker mount the share as a volume, so nothing needs mounting on the host (also in [`compose.yaml`](compose.yaml)), then add a **Folder** source at `/library`:

```yaml
services:
  octo-modern:
    volumes:
      - octo-modern-data:/data
      - nas-library:/library:ro    # drop :ro to allow "Save to library"

volumes:
  nas-library:
    driver: local
    driver_opts:                   # NFS
      type: nfs
      o: addr=nas.lan,ro,nfsvers=4
      device: ":/volume1/3d/gcode"
  # or SMB / CIFS:
  # nas-library:
  #   driver: local
  #   driver_opts:
  #     type: cifs
  #     o: addr=nas.lan,username=printer,password=${NAS_PASSWORD},uid=1000,gid=1000,vers=3.0,ro
  #     device: //nas.lan/3d/gcode
```

The container runs as uid 1000, so the share must be readable (and, for **Save to library**, writable) by it: for NFS, export it to that uid or squash; for CIFS, the `uid`/`gid` options above. With Arcane, put the same lines in the project's compose file.
## Print history

octo·modern records each print itself, from the live state it already keeps:

- **Nobody watching**: the background status poll (`OCM_POLL_INTERVAL_MS`, 10 s) sees a printer start printing and opens a history entry. From then until the print ends, octo·modern holds OctoPrint's push connection open for that printer (one websocket per *printing* printer; idle printers are only polled). The end then arrives as OctoPrint's own `PrintDone`, `PrintFailed` or `PrintCancelled` event, with the exact result and print time. Should the push connection be unavailable (a proxy without websockets), the printer is polled every 2 s instead, and the outcome is read from the state change (100 % done, an error, a "Cancelling" in between) and OctoPrint's record of the file's last print.
- **Someone watching**: the push connection is open anyway; the same events end the entry.
- **octo·modern restarts mid-print**: the open entry continues when the printer is next seen printing the same file, or is closed with OctoPrint's record of how it ended.

A print shorter than one poll interval, started and finished while nobody watched and no other print was running, can be missed; lower `OCM_POLL_INTERVAL_MS` if that matters. Prints started through octo·modern show who started them (from the audit log); others say "OctoPrint". Filament used is the slicer's estimate scaled by how far the print got. The picture is a webcam snapshot taken as the print ends (the slicer's thumbnail when there's no camera), scaled down to at most 100 KB.

**Importing**: the first time a printer is reachable, octo·modern imports its earlier prints once: every print the [PrintJobHistory](https://plugins.octoprint.org/plugins/PrintJobHistory/) plugin recorded, if it's installed, otherwise the last print of each file from OctoPrint's file statistics (OctoPrint counts a cancel as a failure there, so those come in as failed). Admins can import again from the History page; prints already recorded aren't duplicated.

Notifications about prints are set up on the [Notifications](#notifications) page.

`GET /api/history/export.csv` (signed in) returns the history as CSV, with the same filters as the page (`printer`, `result`, `from`, `to`, `q`), including `filament_g`, `material`, `cost_filament`, `cost_energy` and `cost_total`.

## Stats

The **Stats** page sums up the print history for the last 30 days, 90 days, 12 months or all time, for every printer or one:

- **Tiles**: print hours (and how many a day), finished prints with failed and cancelled ones, success rate, filament in metres and grams, cost (only when prints have one, see [Spools, costs and maintenance](#spools-costs-and-maintenance)) and the average print.
- **Charts**: print hours per day (30 days), week (90 days) or month (12 months; all time picks by how far back it goes), stacked by printer; and successes, failures and cancels over the same buckets. Hover or tap a column for its numbers; screen readers get them as a table.
- **Tables**: the most-printed files (prints, success rate, average time of the successful ones, last printed; each opens the History filtered to it), why prints failed or were cancelled, and utilisation: the share of the range each printer spent printing (OctoPrint's print time, so pauses don't count; a print running across the start of the range counts from there).
- **Filament** per material, and per Spoolman spool (by name, with its colour) when Spoolman is set up.
- **Export CSV** downloads the prints of the range with the same columns as the History export.

Everyone sees the printers they have access to and nothing about the others (admins also see printers that were removed since). The page asks the server in your browser's time zone, so a print at 00:30 on the 1st counts for the new month, and days stay days across daylight-saving changes; without one, the server's `TZ` is used. Prints count in the bucket they started in.

The numbers come from `GET /api/stats?range=30d|90d|12m|all&printer=<id>&tz=<IANA zone>` (signed in), aggregated in SQLite with a covering index on the history (a year of a few thousand prints answers in a few milliseconds; 200 000 prints over five years take about half a second for "all time").

## Notifications

Admins set them up under **Notifications** in the sidebar.

**Channels**: [ntfy](https://ntfy.sh) (server, topic, optional token), Discord (webhook), Slack (incoming webhook; Block Kit with the facts and a button back), Telegram (bot token and chat ID; the snapshot as a photo with the caption), Pushover (application token, user key; high priority for errors), Gotify (server, application token; markdown), Matrix (homeserver, room ID, access token of a bot account; the snapshot uploaded as an image), email over SMTP (STARTTLS, TLS or plain; HTML with the snapshot inline), Home Assistant (a webhook trigger, a `notify.*` service with a long-lived token, or both) and generic webhooks (JSON). Tokens, webhook URLs and passwords are stored encrypted and never sent back to the browser. **Send test** in the editor tries the settings on screen, with a test picture, and shows the service's answer word for word when it fails (`HTTP 400: Bad Request: chat not found`, `535 Authentication credentials invalid`…).

**Events**: print started, progress milestones (percentages and/or minutes left, e.g. `25, 50, 75` and `10`), paused (with why: filament runout, M600, a pause in the G-code such as `M0`, the printer, or who pressed pause), finished, failed, cancelled (and who cancelled), printer offline (OctoPrint unreachable or the printer disconnected, after a grace period), printer error, printer back, and still hot after a print (bed or hotend above a threshold N minutes after it ended). Other features raise their own: **Bed clear needed** (queue), **Failure suspected** (failure detection), **Spool low** and **Maintenance due** (Spoolman and maintenance), **Power on** and **Power off** (smart plugs).

**Messages** carry the printer, file, progress, elapsed and estimated time, filament, who started (or cancelled) it, a link back to the printer page, and a fresh webcam snapshot where the channel can take one (the history's picture when there's no camera). Links need octo·modern's **public URL** (Options; `ORIGIN` when empty). Slack, Gotify and Home Assistant's notify service only show pictures by URL: with **Share snapshots by link** on, each snapshot gets an unguessable link under `/api/notify/media/`, readable without signing in for 48 hours.

**Rules** send some events from some printers (or all) to some channels. **Quiet hours** per channel hold messages back in a time window (server time, optionally on certain days), letting errors and failures through if you want. The same event goes to a channel at most once per de-dupe window (10 min), and at most 20 messages per channel per 10 minutes, so a flapping printer can't flood you; "back" only follows an offline or error message. **Recent deliveries** lists the last 100 with their status (sent, failed with the error, quiet hours, duplicate, rate limited).

A generic webhook receives a JSON `POST` (version 2; channels set up before this version keep version 1, the print-end-only shape, until you switch them):

```json
{
  "source": "octo-modern", "version": 2, "event": "print.failed", "severity": "error",
  "title": "Print failed: benchy.gcode",
  "message": "Prusa MK4: benchy.gcode failed after 1h 02m, at 42%, 1.50 m filament, reason: error.",
  "printer": { "id": "…", "name": "Prusa MK4" },
  "print": { "id": 12, "file": "benchy.gcode", "path": "parts/benchy.gcode", "startedAt": "…", "endedAt": "…", "elapsedS": 3720, "estimatedS": 3600, "completion": 42, "filamentMm": 1500, "startedBy": "Otto", "cancelledBy": null, "reason": "error" },
  "fields": [{ "label": "Printer", "value": "Prusa MK4" }, …],
  "data": null,
  "at": "…", "url": "https://octo.example/p/…?tab=history", "imageUrl": null,
  "image": { "contentType": "image/jpeg", "base64": "…" }
}
```

`event` is one of `print.started`, `print.progress`, `print.paused`, `print.finished`, `print.failed`, `print.cancelled`, `printer.offline`, `printer.error`, `printer.online`, `printer.hot`, `queue.bed_clear_needed`, `failure.suspected`, `spool.low`, `maintenance.due`, `power.on`, `power.off`, `bed.drift` or `test`; `image` only when **Include the snapshot** is on. Home Assistant webhook triggers get the same document.

**For developers**: other server code calls `notify({ kind, printerId, title?, message?, fields?, data?, snapshot? })` from `src/lib/server/notify/` with one of the kinds in `src/lib/notify.ts`; rules, quiet hours, de-dupe, snapshots and the log come with it.

## Spools, costs and maintenance

The **Filament** page shows which spool is on which printer, and holds the admin settings for Spoolman and costs. Each printer's dashboard has a **Filament** card with the active spool per extruder.

**Connecting Spoolman** (admins, **Filament → Spoolman**): enter Spoolman's address, e.g. `http://spoolman.lan:7912` (the `/api/v1` address works too). Spoolman has no login of its own; if a reverse proxy in front of it wants one, add an auth header (name and value, e.g. `Authorization: Bearer …`): the value is stored encrypted and never sent back to the browser. **Test** shows Spoolman's version and how many spools it has. octo·modern talks to Spoolman's REST API only from the server, so the browser doesn't need to reach it.

**Choosing the spool**: operators click **Choose** / **Change** on a printer's Filament card and pick from Spoolman's spools (not archived), searchable by name, vendor, material, location and lot, with the colour, material and what's left. A printer with several extruders (from its live temperatures: `tool0`, `tool1`, …) gets one spool per tool. A spool sits on one tool at a time; moving it elsewhere takes it off the first.

**Reporting use**: while a print runs, octo·modern estimates the filament used per tool from OctoPrint's analysis × progress and reports it in steps of about a metre (`PUT /api/v1/spool/<id>/use` with `use_length` in mm; Spoolman converts to weight with the filament's density and diameter). When the print ends, the rest is reported, so the total matches the history entry (a cancelled print counts only what it got through). Reports that fail (Spoolman down) are retried for a week, and never sent twice. Turn off **Report use while printing** to report only at the end.

**Before printing**: starting a print (a file's **Print**, the job **Print** and **Restart** buttons, **Print again** in the history, or **Send & print** from the library) compares the file's filament with what's left on each tool's spool. When it won't last, you're asked first (the API answers 409 with `confirmRequired`, then accepts `confirm: true`, or `confirmFilament: true` for library sends). The [print queue](#print-queue) checks too, and holds the job instead of asking. If Spoolman can't be reached, printing isn't held up.

**Low spools**: below the threshold (100 g by default) a spool turns red on the dashboard, and the `spool.low` notification is sent once per spool, again only after it was refilled or replaced.

**Costs** (admins, **Filament → Print costs**): currency, electricity price per kWh, an average power draw while printing (a default and per printer), and a price per kg and density per material, with a default material and filament diameter for prints whose spool isn't known. Each print's cost is filament (grams from the spool's density, priced with the spool's price from Spoolman when it has one, else the material's) plus electricity (print time × draw × price). It's stored on the history entry when the print ends; entries without a cost (earlier and imported prints) are costed when the settings are saved and every few hours. **Recalculate history** re-costs every finished print with today's prices (prints priced from a Spoolman spool keep that price).

**Maintenance** (the **Maintenance** page, and a tab per printer): tasks with an interval in print hours, kg of filament or days, counted from the print history since the task was last done (or since a "last done" date you give when adding it). New printers are offered nozzle change (500 h), belt tension (200 h), lubricating rods and rails (150 h), cleaning the bed (7 days) and checking e-steps (5 kg). A task is **due soon** at 90 % of its interval and **overdue** past it; the sidebar shows how many are overdue, and `maintenance.due` is sent once when a task becomes overdue. **Done** (operators) logs who did it, when, at what usage and your notes, and starts the count again.

## Bed mesh

Printers whose OctoPrint has the [Bed Visualizer](https://github.com/jneilliii/OctoPrint-BedLevelVisualizer) plugin (OctoPrint-BedLevelVisualizer) get a **Bed** tab; the others show no bed-mesh UI at all (the printer's settings dialog says where the tab comes from). octo·modern asks OctoPrint whether the plugin is there (`plugins.bedlevelvisualizer` in `GET /api/settings`) when the printer page is first opened and every 15 minutes, and remembers the answer.

- **The mesh**: a heatmap laid out as seen from the front (the back of the bed at the top), each cell with its value in mm, coloured on a scale around the mean (blue below, warm above; theme colours `--mesh-low/-mid/-high`, readable in light and dark), with the lowest and highest points outlined; and a 3D surface (drag to rotate, wheel or pinch to zoom, arrow keys and +/−, double-click to reset; heights are exaggerated and say so). Above them: **flatness** (max − min), the lowest and highest point with their X/Y, the mean and how many points were probed. Cells the probe didn't report (`nan`, empty) stay grey and are left out of the numbers.
- **Update mesh** (operators): sends `@BEDLEVELVISUALIZER` and the plugin's own probe G-code (OctoPrint → Settings → Bed Visualizer → Collection, e.g. `G28` and `G29 T`), which is what the plugin's own button does; the plugin has no REST command for it. It asks first (the printer homes and moves; `409` with `confirmRequired`), is refused while a print is running or the printer is disconnected, shows progress, and the tab refreshes when the plugin reports the new mesh on its push socket. Without a push connection it watches the plugin's stored mesh instead. The new mesh is written back into the plugin's settings, as its own UI does, so OctoPrint shows it too (unless the plugin's "save mesh" is off).
- **History**: every distinct mesh is stored with when it was first and last seen: meshes probed here, ones the plugin reports live, and ones probed from OctoPrint (a print's start G-code with the plugin's at-command, or its own UI). Pick any two to see a **difference map** (later − earlier; meshes with a different probe count are interpolated over the bed) with the largest change and mean shift, follow **flatness over time**, set a **reference** mesh (★) and delete bad probe runs. The newest 250 are kept per printer, plus the reference and the oldest.
- **Drift alerts** (per printer, in the tab): a flatness limit and/or a limit on how far any point may move from the reference mesh (the oldest kept unless you choose one). Each new mesh is checked; one that breaks a limit is flagged in the history and, with alerts on, sends `bed.drift` to the channels whose rules include **Bed mesh drift**.

API: `GET /api/printers/<id>/bedmesh` (plugin status, the latest mesh, history, drift settings; `?refresh=1` asks OctoPrint again), `GET /api/printers/<id>/bedmesh/<mesh>` (one mesh with its grid), `POST /api/printers/<id>/bedmesh` `{ "action": "update", "confirm": true }`, `PUT /api/printers/<id>/bedmesh` `{ enabled, maxFlatness, maxChange, referenceId }` (mm), `DELETE /api/printers/<id>/bedmesh/<mesh>`. Updates, drift settings and deletions are in the audit log (`bedmesh.*`). Meshes aren't part of backups.

## Smart plugs

Admins set up a printer's plug from its settings (the settings icon in the printer header → **Smart plug** → **Set up**); once a plug exists, the dashboard shows a **Power** card, whose settings icon opens the same dialog. Printers without a plug show no Power card, and without Spoolman there is no Filament card. **Test** reads the plug's state without switching it. Usernames, passwords and tokens are sealed with AES-256-GCM like API keys and never sent back to the browser (leave a field empty to keep what's saved); credentials in a URL are refused. Backups include each printer's plug with its credentials.

| Device | How octo·modern talks to it | Login | Watts / energy |
| --- | --- | --- | --- |
| **Shelly Gen1** (Plug S, 1PM, …) | `/relay/<n>?turn=on\|off`, state and meter from `/status` | Basic (if set) | ✓ |
| **Shelly Gen2+** (Plus, Pro, Gen3/4) | RPC `Switch.Set` / `Switch.GetStatus` (generation detected from `/shelly`) | Digest, user `admin` | ✓ |
| **Tasmota** | `/cm?cmnd=Power<n> On\|Off`, energy from `Status 8` | web admin password, as `user`/`password` | ✓ (energy-monitoring builds) |
| **Home Assistant** | `switch.*`, `light.*` or `input_boolean.*` over the REST API | long-lived access token | optional `sensor.*` entities (W, kWh) |
| **HTTP** | your own on/off (and optional status) URLs and methods; the status answer is matched against a text or `/regex/` | Basic/Digest or an `Authorization` header | – |

Operators switch printers from the printer header, the **Power** card, the overview card, or by right-clicking (long-pressing) a printer in the sidebar:

- **Turning off** disconnects OctoPrint from the printer first. While a hotend or the bed is hot (50 °C / 40 °C by default) it asks first; while a print runs it always asks twice, and the server enforces both (`409` with `confirmField: "confirm"`, then `"confirmPrinting"`).
- **Connect after power-on** (on by default): once the plug is on, octo·modern waits for the printer and asks OctoPrint to connect, retrying for about three minutes.
- **Power off after a print**: when a print ends, a countdown starts; once the printer has been idle for N minutes (default 10) *and* every hotend is below X °C (default 50), octo·modern disconnects it and switches the plug off. A new print cancels the countdown, and **Keep on** (card, overview, sidebar menu) cancels it for this print. While print-queue jobs wait for that printer's bed to be cleared, a due power-off is held (the card says so) unless **Stay on for the print queue** is turned off. A running countdown is saved in the database, so a restart of octo·modern doesn't lose it: it carries on afterwards, and if its time ran out while octo·modern was down, nothing is switched off until the printer has been seen again and the conditions are checked anew (idle, hotends cool, plug still on); a printer printing by then is never switched off, and the countdown is dropped.
- **Power on for new prints**: printing a file (or sending one from the library with **Send & print**) to a printer whose plug is off switches it on and waits for it to connect first. The print queue does the same: when a printer with auto power-on is off (or disconnected), its bed is confirmed clear and a queued job fits it, the queue switches it on, waits for it to connect and starts the job. Other features call `ensurePrinterOn(printerId)` from `src/lib/server/power/service.ts`.

Every switch, test, setup change, auto power-on/off, countdown and "Keep on" is in the audit log (`power.*`; automatic ones without a user), and notification channels can subscribe to **Power on** / **Power off** (`event: "power.on"` / `"power.off"` in the webhook JSON, with `print: null`). Plug readings refresh every 15 s; the API is `GET /api/power` (every visible printer's plug: state, watts, countdown, no addresses), `GET/POST /api/printers/<id>/power` (`{ action: "on" | "off" | "keep_on" }`), and for admins `GET/PUT/DELETE /api/printers/<id>/power/config` and `POST …/power/test`.

## Timelapses

The **Timelapse** tab lists OctoPrint's rendered timelapses with their thumbnails, plays them in the browser and downloads them. octo·modern relays the videos with HTTP Range requests passed through, so the player can seek without downloading the whole file, and the browser never needs to reach OctoPrint. Operators delete timelapses and render or delete unrendered ones; admins change the settings (off, on each layer change, or timed; frame rate, interval, post-roll). OctoPrint needs a webcam snapshot URL and ffmpeg to record timelapses (the `octoprint/octoprint` image has ffmpeg).

## Failure detection

octo·modern watches printing printers with **Obico's failure-detection model** (the "Spaghetti Detective"), running in your own `ml_api` container from [obico-server](https://github.com/TheSpaghettiDetective/obico-server). No Obico account or cloud is involved. Add the container with [`compose.detect.yaml`](compose.detect.yaml):

```sh
echo "ML_API_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose -f compose.yaml -f compose.detect.yaml up -d
```

Then, as an admin, check **Settings → Failure detection** (the ML API URL, its token, and *octo·modern's address as the ML container sees it*, usually `http://octo-modern:3000`); **Test** checks the model is loaded and does a full round trip. Turn detection on per printer in its **Failure detection** tab.

**What happens while a printer prints**

1. After the first minutes of the print (default 5, by OctoPrint's print time; covers the first layer), every *N* seconds (default 10, which is what Obico's thresholds are tuned for) octo·modern takes a webcam snapshot, the same way the Webcam tab does.
2. It sends the ML API `GET /p/?img=<one-time link to that frame>`; the container downloads the frame and answers with boxes and confidences.
3. The detections feed a smoothed **failure score**, Obico's first-generation algorithm ported as is (and tested frame by frame against obico-server's code): `p` = the sum of the frame's confidences; an exponentially weighted mean of `p` over 12 frames; minus a long-term baseline of what this camera normally looks like (a rolling mean over ~7200 frames, kept per printer across prints, so a camera that always sees a bit of "failure" doesn't cry wolf); times the sensitivity (Obico's `detective_sensitivity`, 1.0 by default). It's compared against a warning threshold of `(short-term mean − baseline) × 3.8`, clamped to 0.38–0.78, and a failure threshold of 1.75 × that. The panel shows it on Obico's 0–100 % scale: **warning** from 33 %, **failure** from 67 %.
4. **Warning**: a `failure.suspected` notification with the frame, boxes drawn in (once; again only after 10 minutes back to normal). **Failure**, once per print, the printer's setting: *do nothing*, *notify*, or *pause the print* (OctoPrint's pause, in the audit log as `octo·modern detector`, plus a notification).
5. **This is a false alarm** (operators) turns detection off until the print ends. Paused prints get no frames; nothing is resumed automatically.

The tab shows the score over the print, the last analysed frame with its boxes, what happened (warnings, pauses, errors such as an unreachable ML API) and the settings. These go to the channels of every [notification rule](#notifications) with **Failure suspected**, with the annotated frame as the picture (attached, or by link). A generic webhook gets `"event": "failure.suspected"` with `"data": { "detection": { "level": "warning" | "failure", "score": 0.71, "action": "notify" | "none" | "paused" | "pause-failed" } }`, and the JPEG in `"image"` when **Include the snapshot** is on.

**The ML API, as verified in obico-server's source** (`release` branch, commit `6f93896`: `ml_api/server.py`, `ml_api/auth.py`, `ml_api/lib/onnx.py`, `backend/lib/prediction.py`, `backend/lib/failure_detection.py`):

| | |
| --- | --- |
| `GET /p/?img=<url>` | Downloads the image from `<url>` (0.1 s connect / 5 s read timeout, up to 3 tries on connection errors and 5xx), returns `200 {"detections": [["failure", 0.83, [xc, yc, w, h]], …]}`: box centre and size in pixels of that image, every box above 0.08 confidence. `400 {"detections": [], "message": …}` when it can't fetch or decode the image, `422` without `img` |
| `GET /hc/` | `ok` once the model has loaded (no auth) |
| Auth | With `ML_API_TOKEN` set on the container, `/p/` needs `Authorization: Bearer <token>` and answers a bare `401` otherwise; without it, no auth |

There is **no endpoint that takes image bytes** (no POST, no upload), so the frame has to be at a URL the container can reach, which is why octo·modern serves it through the one-time link (see [Security model](#security-model)). Detection state (the score and its history, alerts already sent, a pause already done, a false-alarm mark) is saved after every frame, so after a restart of octo·modern detection carries on where it was for the same print; if a different print is running by then (another file, the file started again, a new history entry), the saved state is discarded and it starts afresh. The long-term baseline is saved separately.

## Print queue

**Queue** (in the sidebar) holds prints waiting for a printer; each printer's **Queue** tab shows the jobs it could take.

- **Adding jobs**: **Add job** on the Queue page (from the library, or upload a file, which octo·modern keeps in its data folder until the job is removed), **Add to queue** on a library file, or the queue button on a file in a printer's **Files** tab (that file prints on that printer only). Slicers can add jobs too ([Slicer uploads](#slicer-uploads)).
- **Which printer**: a job targets one printer, or **any compatible printer**: one whose tags include every tag the job requires. Admins set each printer's tags on the Queue page (free-form, e.g. `0.4mm`, `petg`, `bed:300`). Jobs added by an operator who only sees some printers only go to those.
- **Order and copies**: drag a job (or use the up/down arrows; on phones, the ⋯ menu) to reorder; set how many copies to print. Copies print one after another, each needing a clear bed.
- **Bed is clear**: every print, queued or not, leaves the printer **awaiting bed clear**; nothing more is sent to it until someone confirms with **Bed is clear** (on the overview card, the printer page or the Queue page). Printers start out unconfirmed. When jobs are waiting, a `queue.bed_clear_needed` notification goes to the channels of every [notification rule](#notifications) with **Bed clear needed**. A button or automation next to the printer can confirm too: `POST /api/status/<printer id>/bed-clear` with a status token created with **May confirm bed clear**.
- **Dispatch**: every few seconds (and right after a change), each printer that's connected, idle, not paused and confirmed clear takes the first matching job. Library and uploaded files are transferred first unless the printer already has a file of that name and size; then octo·modern selects and prints it, crediting the person who queued it in the history.
- **Filament**: with [Spoolman](#spools-costs-and-maintenance) set up, the same check as a manual start runs before each job starts: when a spool on that printer won't last the file (from OctoPrint's analysis, the library's slicer metadata, or the uploaded file's header), the job is **held** instead of started, with the reason under it, and a **Spool low** (`spool.low`) notification says so. **Check again** (after loading a fuller spool) puts it back in the queue; **Print anyway** does too and skips the check for its next start. Other jobs carry on meanwhile.
- **Failures**: if a queued print fails or is cancelled, or can't be started, the job is marked failed (with **Requeue**, which puts it at the end) and that printer's queue is paused until someone resumes it. **Pause queue** stops all new starts; running prints carry on.
- **History**: each run of a job is linked to its print history entry. The queue and every printer's state are kept in the database, so a restart picks up where it left off.

## Slicer uploads

octo·modern answers enough of OctoPrint's API for slicers to upload to it: `GET /api/version`, `GET /api/server`, `POST /api/files/local` (multipart, honouring `print`/`select` and `path`), plus the read-only settings, printer profile, printer, job and connection answers Cura's plugin polls. It lives under **`/octoprint`**, so the slicer's host is

```
http://<octo·modern host>:3040/octoprint
```

(octo·modern's own `/api/…` is a different, session-only API; the prefix keeps the two apart.)

1. Under **Integrations → Slicer upload keys** (admins), create a key and choose where its uploads go:
   - **The print queue**: a job for a chosen printer, or for any printer with the tags you give (e.g. a "PETG" key);
   - **A library folder**: a folder in a *writable* library source (the slicer's subfolder, if any, goes below it);
   - **A printer**: straight into its OctoPrint, optionally allowed to start the print ("Upload and print").
2. Copy the key (shown once). It is an `ocm_…` token with scope `upload`; it opens `/octoprint/api/…` and nothing else, and can expire or be revoked like other tokens.
3. Add octo·modern in the slicer:
   - **PrusaSlicer**: Printer settings → Physical printer (the cog next to the printer) → Host type **OctoPrint**, Hostname/IP/URL `http://octo-modern.lan:3040/octoprint`, API key = the key → **Test**. Then **Send to print host** (or *Upload and print*).
   - **OrcaSlicer**: the printer's **Connection** (Wi-Fi icon next to the printer) → Host type **Octo/Klipper**, Hostname/IP/URL `http://octo-modern.lan:3040/octoprint`, API key = the key → **Test** → **OK**. Use **Print** / **Send** on the Prepare/Preview tab.
   - **Cura**: Marketplace → install **OctoPrint Connection** → Preferences → Printers → **Connect OctoPrint** → **Add** a manual instance: Name *octo·modern*, IP address or hostname `octo-modern.lan`, Port `3040`, Path `/octoprint/`; paste the key into **API key** (if Cura refuses the underscore, paste it without `ocm_`), then **Connect**. **Print with OctoPrint** uploads (Cura asks to start the print; only keys for a printer that may start prints do).

Keys are letters and digits after `ocm_`, and octo·modern also accepts them without the prefix. An upload with *Upload and print* to the queue or library just stores the file (the queue starts it when a printer is ready).

## Dashboards and monitoring

Create a token under **Integrations → Status API tokens** (admins). It's shown once; only its SHA-256 is stored. Tokens can expire, can be revoked, and record when they were last used. They open these routes only, and only for `GET` (plus the bed-clear `POST` for tokens allowed to). They're never accepted as a session anywhere else.

| Route | Returns |
| --- | --- |
| `GET /api/status` | `{ printers, online, printing, checkedAt, items: [...] }` |
| `GET /api/status/<id>` | one item; add `?strict=1` to get HTTP 503 while it's unreachable or in an error state |
| `GET /api/status/badge/<id>.svg` | a shields-style badge, e.g. `printing 42%` (`?label=` sets the left text) |
| `POST /api/status/<id>/bed-clear` | confirms the printer's bed is clear for the [print queue](#print-queue); only tokens created with **May confirm bed clear** (409 while it prints) |

Each item has `id`, `name`, `state` (`operational`, `printing`, `paused`, `error`, `offline`, `disconnected`, …), `stateLabel`, `online`, `printing`, `progress` (0–100 while a job runs), `file`, `printTimeSeconds`, `printTimeLeftSeconds`, `eta`, `filamentMeters`, `temperatures` (`{ tool0: { actual, target }, bed: … }`), `version`, `lastUpdatedAt`, and, when unreachable, a short `error` code such as `ECONNREFUSED`. The OctoPrint URL is included only if the token was created with **Include addresses**. Answers come from the state octo·modern already keeps, so frequent polling never reaches OctoPrint. Printer ids are in `/api/status` and in each printer's URL (`/p/<id>`).

Send the token as `Authorization: Bearer ocm_…`. Widgets that can't set headers can use `?token=ocm_…`; URLs end up in proxy logs and browser history, so prefer the header and give such a widget its own token.

```sh
curl -H "Authorization: Bearer $OCM_TOKEN" http://octo-modern.lan:3040/api/status
```

**[Homepage](https://gethomepage.dev)** (`services.yaml`, customapi widget):

```yaml
- 3D printing:
    - octo·modern:
        href: http://octo-modern.lan:3040
        widget:
          type: customapi
          url: http://octo-modern.lan:3040/api/status
          refreshInterval: 30000
          headers:
            Authorization: Bearer ocm_xxxxxxxx
          mappings:
            - field: printing
              label: Printing
            - field: online
              label: Online
            - field: printers
              label: Printers
```

**[Glance](https://github.com/glanceapp/glance)** (custom-api widget):

```yaml
- type: custom-api
  title: Printers
  cache: 30s
  url: http://octo-modern.lan:3040/api/status
  headers:
    Authorization: Bearer ocm_xxxxxxxx
  template: |
    <ul class="list list-gap-10">
    {{ range .JSON.Array "items" }}
      <li class="flex justify-between">
        <span>{{ .String "name" }}</span>
        <span>{{ .String "stateLabel" }}</span>
      </li>
    {{ end }}
    </ul>
```

**Home Assistant** (`configuration.yaml`):

```yaml
rest:
  - resource: http://octo-modern.lan:3040/api/status/<printer id>
    headers:
      Authorization: Bearer ocm_xxxxxxxx
    scan_interval: 30
    sensor:
      - name: Prusa state
        value_template: "{{ value_json.stateLabel }}"
      - name: Prusa progress
        value_template: "{{ value_json.progress or 0 }}"
        unit_of_measurement: "%"
      - name: Prusa time left
        value_template: "{{ value_json.printTimeLeftSeconds or 0 }}"
        unit_of_measurement: s
```

**Uptime Kuma**: an HTTP monitor on `/api/status/<id>?strict=1&token=ocm_…` goes down when OctoPrint is unreachable or the printer reports an error.

## Images

Images are published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`:

| Tag | Tracks |
| --- | --- |
| `ghcr.io/vitafortis/octo-modern:latest` | the latest build of `main` |
| `ghcr.io/vitafortis/octo-modern:0.1.<run>` | every build of `main` (the version shown in the sidebar) |
| `ghcr.io/vitafortis/octo-modern:1`, `:1.2`, `:1.2.3` | releases (`v*` tags) |

To build it yourself: `docker build -t octo-modern .`

## Screenshots

On a phone (390 px): the dashboard while printing, files, the jog pad, and the light theme.

<p align="center">
  <img src="docs/screenshots/mobile-dashboard.png" alt="Dashboard on a phone" width="24%" />
  <img src="docs/screenshots/mobile-files.png" alt="Files on a phone" width="24%" />
  <img src="docs/screenshots/mobile-control.png" alt="Control on a phone" width="24%" />
  <img src="docs/screenshots/mobile-light.png" alt="Light theme on a phone" width="24%" />
</p>

| | |
| --- | --- |
| ![Printer dashboard](docs/screenshots/printer.png) | ![Files](docs/screenshots/files.png) |
| **Dashboard**: live webcam, job, temperatures | **Files**: upload, print, delete |
| ![Webcam](docs/screenshots/webcam.png) | ![Cancel confirmation](docs/screenshots/confirm-cancel.png) |
| **Webcam**, relayed through octo·modern | **Cancel** always asks first |
| ![Light theme](docs/screenshots/printer-light.png) | ![Overview, light](docs/screenshots/overview-light.png) |
| **Light theme** | **Overview**, light |
| ![Users](docs/screenshots/users.png) | ![Audit log](docs/screenshots/audit.png) |
| **Users**: admins, operators, viewers | **Audit log** |
| ![Library](docs/screenshots/library-light.png) | ![Send to printer](docs/screenshots/library-send.png) |
| **Library**: previews and slicer details from your NAS | **Send & print** to any printer |
| ![From library](docs/screenshots/library-picker.png) | ![Library source](docs/screenshots/library-source-edit.png) |
| **From library** in a printer's Files tab | **Library sources**: folder, SMB, SFTP, WebDAV |
| ![History](docs/screenshots/history.png) | ![History, light](docs/screenshots/history-light.png) |
| **History**: every print, stats per printer and week | **History**, light |
| ![A print in the history](docs/screenshots/history-entry.png) | ![Printer history](docs/screenshots/printer-history.png) |
| **A print**: how it ended, notes, print again | **History tab** of one printer |
| ![Timelapse player](docs/screenshots/timelapse-player.png) | ![Timelapses, light](docs/screenshots/timelapse-light.png) |
| **Timelapse**: play with seeking, download | **Timelapse settings**, light |
| ![Failure detection](docs/screenshots/detection.png) | ![Failure detection, light](docs/screenshots/detection-light.png) |
| **Failure detection**: score, last frame with boxes, paused by the detector | **Failure detection**, light |
| ![Queue](docs/screenshots/queue.png) | ![Queue, light](docs/screenshots/queue-light.png) |
| **Queue**: jobs, copies, printers and their tags | **Queue**, light |
| ![Bed is clear](docs/screenshots/queue-bed-clear.png) | ![Slicer upload keys](docs/screenshots/slicer-keys.png) |
| **Queue tab**: confirm the bed is clear | **Slicer upload keys** for PrusaSlicer, OrcaSlicer, Cura |
| ![Queue on a phone](docs/screenshots/mobile-queue.png) | ![Bed is clear on a phone](docs/screenshots/mobile-queue-bed-clear.png) |
| **Queue** on a phone | **Bed is clear** on a phone |
| ![Notifications](docs/screenshots/notifications-light.png) | ![Channel editor](docs/screenshots/notifications-channel.png) |
| **Notifications**: rules, options, delivery log | **Send test** shows the service's own answer |
| ![Settings](docs/screenshots/settings.png) | ![Sign in](docs/screenshots/login.png) |
| **Settings**: security and backup | **Sign in** |
| ![Filament card on the dashboard](docs/screenshots/spools-dashboard.png) | ![Choosing a spool](docs/screenshots/spool-picker.png) |
| **Filament** card: the active spool per extruder | **Choose a spool** from Spoolman |
| ![Not enough filament](docs/screenshots/filament-warning.png) | ![Filament page](docs/screenshots/filament-light.png) |
| **Not enough filament**: asked before printing | **Filament**: spools, Spoolman and costs |
| ![Maintenance](docs/screenshots/maintenance.png) | ![Mark done](docs/screenshots/maintenance-done.png) |
| **Maintenance**: due and overdue per printer | **Done**, with notes, logged |
| ![Stats](docs/screenshots/stats.png) | ![Stats, light](docs/screenshots/stats-light.png) |
| **Stats**: print hours by printer, outcomes, tiles | **Stats**, light, 90 days |
| ![Stats tables](docs/screenshots/stats-tables.png) | ![Stats on a phone](docs/screenshots/mobile-stats.png) |
| **Stats**: most-printed files, filament per material and spool | **Stats** on a phone |
| ![History with costs](docs/screenshots/history-costs.png) | ![Maintenance, light](docs/screenshots/maintenance-light.png) |
| **Cost per print** in the history | **Maintenance**, light |
| ![Bed mesh](docs/screenshots/bedmesh.png) | ![Bed mesh, light](docs/screenshots/bedmesh-light.png) |
| **Bed mesh**: heatmap, 3D surface, flatness | **Bed mesh**, light |
| ![Comparing meshes](docs/screenshots/bedmesh-compare.png) | ![Bed mesh on a phone](docs/screenshots/mobile-bedmesh.png) |
| **Compare** two meshes, flatness over time, drift alerts | **Bed mesh** on a phone |
| ![Queue job held for filament](docs/screenshots/queue-held-filament.png) | |
| **Queue**: a job held because the spool won't last, with **Check again** / **Print anyway** | |
| ![Smart plug](docs/screenshots/power.png) | ![Power overview](docs/screenshots/power-overview.png) |
| **Power**: plug state, watts, auto power-off countdown | **Overview** and sidebar menu: on/off, Keep on |
| ![Smart plug setup](docs/screenshots/power-config.png) | ![Second confirmation](docs/screenshots/power-confirm.png) |
| **Smart plug setup** with Test | Cutting power mid-print asks **twice** |
| ![Discover, light](docs/screenshots/discover-light.png) | ![Setup wizard](docs/screenshots/setup-discover.png) |
| **Discover**, light | **Setup** offers what it found |
| ![Approve in OctoPrint](docs/screenshots/discover-approve.png) | ![Discover: Arcane](docs/screenshots/discover-arcane.png) |
| **Application Keys**: approve in OctoPrint | **Arcane** environments |

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `OCM_DATA_DIR` | `./data` (`/data` in the image) | Encrypted SQLite store and key file |
| `OCM_SECRET_KEY` | — | Master secret. Unset means a random key is generated in `secret.key` |
| `OCM_ADMIN_EMAIL`, `OCM_ADMIN_PASSWORD`, `OCM_ADMIN_NAME` | — | Create the first admin on start instead of using the setup wizard |
| `OCM_AUTH` | — | `disabled` skips sign-in entirely and gives everyone admin access (trusted networks only). To keep admin accounts but let guests watch or control printers, use **Settings → Sign-in** instead |
| `OCM_LOCAL_LOGIN` | — | `disabled` hides the email/password form (SSO only); `enabled` forces it back on |
| `OCM_OIDC_ISSUER` | — | OIDC issuer URL; enables SSO (or configure it under Integrations) |
| `OCM_OIDC_CLIENT_ID`, `OCM_OIDC_CLIENT_SECRET` | — | Client credentials from your identity provider |
| `OCM_OIDC_NAME` | `SSO` | Login button label |
| `OCM_OIDC_SCOPES` | `openid email profile` | Requested scopes |
| `OCM_OIDC_AUTO_CREATE` | — | Emails that get an account on first login: `*@example.com`, `bob@gmail.com`, `*` |
| `OCM_OIDC_ADMIN_EMAILS` | — | Auto-created accounts matching these become admins |
| `OCM_OIDC_DEFAULT_ROLE` | `viewer` | Role for other auto-created accounts (`viewer` or `operator`) |
| `OCM_OIDC_REDIRECT_URI` | `<origin>/auth/oidc/callback` | Override when the public URL can't be inferred |
| `OCM_DOCKER_HOSTS` | the local socket, if present | Docker endpoints for Discover, e.g. `tcp://docker-proxy:2375,tcp://nas.lan:2375`; `none` turns it off |
| `OCM_SELF_CONTAINER` | — | octo·modern's own container name, when Discover can't find it by hostname or IP |
| `OCM_ARCANE_URL`, `OCM_ARCANE_API_KEY`, `OCM_ARCANE_NAME` | — | An Arcane instance for Discover (or connect one in the UI) |
| `OCM_ML_API_URL` | — | Obico's ML API for failure detection, e.g. `http://ml_api:3333` (or set it under Settings → Failure detection, which overrides this) |
| `OCM_ML_API_TOKEN` | — | The ml_api container's `ML_API_TOKEN`, sent as `Authorization: Bearer …` |
| `OCM_DETECT_PUBLIC_URL` | — | octo·modern's address as the ML container reaches it, e.g. `http://octo-modern:3000` |
| `ORIGIN` | — | octo·modern's public address (adapter-node); also the default for links in notifications |
| `OCM_PUSHOVER_API` | Pushover's API | Where Pushover messages go (tests point it at a mock) |
| `OCM_POLL_INTERVAL_MS` | `10000` | Status poll for printers nobody is watching live |
| `OCM_REQUEST_TIMEOUT_MS` | `10000` | Timeout for each request to OctoPrint |
| `OCM_PUSH_THROTTLE` | `2` | Live updates arrive every 500 ms × this |
| `OCM_TEMP_HISTORY_MINUTES` | `30` | Temperature history kept in memory per printer |
| `BODY_SIZE_LIMIT` | `4G` in the image | Largest upload |
| `TZ` | `UTC` | Time zone for logs, and for Stats buckets when the browser doesn't send its own |
| `PROTOCOL_HEADER`, `HOST_HEADER` | — | Set to `x-forwarded-proto` / `x-forwarded-host` behind a TLS reverse proxy |

## Backup & restore

Under **Settings → Backup & restore**, admins download an encrypted file with printers (with their API keys and smart plugs), users (roles, password hashes, SSO links, printer access), settings (single sign-on, failure detection with its ML API token), notifications (channels with their tokens, rules, options), the print queue (jobs and printer tags; files uploaded to the queue aren't included, so such jobs come back asking for the file), spools & maintenance (the Spoolman connection with its auth header, cost settings, the spool on each printer, maintenance tasks and their log; not the per-print reports to Spoolman, so nothing is reported twice) and, when ticked, the print history (optionally with its pictures, up to 100 KB each; can make the file large). It's sealed with a passphrase you choose, not the master key, so it restores on a new install. A restore shows what it will add or update before applying; printers are matched by id and users by email, notifications are replaced as a whole, history entries, queued jobs and maintenance tasks already present are kept (no duplicates), nothing else is deleted, and your own account is never changed. The audit log, the delivery log and API tokens aren't included. A large backup needs a `BODY_SIZE_LIMIT` above adapter-node's 512 KB default outside the image (the image allows 4 GB).

## Security model

- **API keys** are sealed with AES-256-GCM, bound to their printer's id, and never sent to the browser, not even to admins. The SQLite file and key file are created with mode `0600`. Back up `secret.key`, or set `OCM_SECRET_KEY`; without it, stored keys can't be recovered.
- **The browser never talks to OctoPrint.** Status, the push connection, webcam images and streams, thumbnails and uploads all go through octo·modern. Camera URLs of relayed cameras aren't sent to the browser either. A camera request carries the API key only when the camera is on OctoPrint's own origin.
- **Least privilege**: an OctoPrint Application Key acts as the user who approved it. Use a key of a user with only the permissions you want octo·modern to have; **Test connection** lists what it lacks.
- **Access** is checked on the server for every printer-scoped page and API call. Viewers can't reach any route that changes a printer; operators can't reach server, user or settings routes. Confirmations for dangerous actions are enforced by the server.
- **API tokens** (`ocm_` + 32 random bytes, SHA-256 hashed at rest) only work on `GET /api/status…`; they never become sessions, and repeated bad tokens from one address are throttled. Status responses omit OctoPrint URLs unless the token allows it, and report errors as codes only.
- **Sign-in** is by OIDC or by local accounts (scrypt-hashed passwords, login throttle). Sessions are httpOnly cookies tied to a user and end when the user is disabled or their role changes. Writes from another origin are rejected.
- **Discovery** is admin-only and read-only: Docker and Arcane are only read (`GET`), a socket proxy keeps writes blocked, and fingerprinting uses unauthenticated `GET`s. Keys from the Application Keys flow are polled for by octo·modern's server and go straight into the encrypted store; the browser only sees the request's state. Subnet scans need an admin, are capped at 4096 addresses and are audited.
- **Library sources**: NAS passwords and SFTP keys are sealed like API keys (bound to the source) and never sent to a browser. Sources are read-only unless an admin allows writing; folder sources refuse `..` and symlinks that lead outside the folder; SFTP host keys can be pinned.
- **Failure detection frames**: Obico's ML API only accepts an image URL, so octo·modern serves each frame at `/api/detect/frame/<token>`: a 256-bit random, single-use token (only its SHA-256 is kept, in memory) that expires after 30 s and is revoked when the ML API answers. It serves that one captured frame, never the camera itself. Apart from the token-only status API, it's the only path open without a session, and only for `GET`. The ML API token is sealed like API keys.
- **Backup files** hold decrypted API keys and the SSO client secret, re-encrypted with AES-256-GCM under a key derived from your passphrase (scrypt). Treat the file and its passphrase like a password manager export.

## Development

```sh
pnpm install
pnpm dev                              # http://localhost:3040
pnpm check && pnpm test               # types + unit tests
scripts/dev-octoprint.sh up 2         # two OctoPrint servers with virtual printers on :5101, :5102
node scripts/mjpeg-source.mjs 5190    # a fake MJPEG webcam on :5190
pnpm e2e                              # end-to-end against real OctoPrint containers (needs Docker)
pnpm e2e:control                      # the Control and Terminal tabs end-to-end (OctoPrint on :5131, app on :3150)
pnpm e2e:discover                     # Discover end-to-end: real OctoPrint, mock Docker/Arcane/mDNS, Application Keys
pnpm e2e:library                      # the Library against OctoPrint, SFTP, Samba and WebDAV containers
```

`scripts/dev-octoprint.sh` starts `octoprint/octoprint` containers with the built-in Virtual Printer enabled, the first-run wizard skipped and an admin user (`admin` / `octoprint-dev`) whose API key is `ocm-dev-key-<n>`; `env` prints their URLs and keys, `down` removes them. `pnpm e2e` builds the app, starts two such servers and the fake webcam, and drives octo·modern over HTTP and in Chromium: setup, adding servers, live temperatures over SSE, roles, uploads (including a 200 MB one, checking memory), printing, pausing, resuming and cancelling, webcam streaming and cleanup. It writes the screenshots in `docs/screenshots/` and removes its containers afterwards. `pnpm e2e:library` does the same for the Library: a folder source plus SFTP (`atmoz/sftp`), Samba (`crazymax/samba`) and WebDAV (`rclone serve webdav`) servers, browsing, metadata, search, send & print, 150 MB transfers from each with a memory check, and Save to library.
pnpm e2e:history                      # print history, notifications and timelapses end to end
pnpm e2e:notify                       # notifications: every channel type against local mocks, a real virtual printer
pnpm e2e:mobile                       # phones: no sideways scrolling at 360/390/430 px, thumb-sized controls
pnpm e2e:stats                        # the Stats page on seeded demo history (no Docker)
pnpm e2e:bedmesh                      # the Bed tab against a mock OctoPrint with the Bed Visualizer plugin (no Docker)
```

`scripts/dev-octoprint.sh` starts `octoprint/octoprint` containers with the built-in Virtual Printer enabled, the first-run wizard skipped and an admin user (`admin` / `octoprint-dev`) whose API key is `ocm-dev-key-<n>`; `env` prints their URLs and keys, `down` removes them. `pnpm e2e` builds the app, starts two such servers and the fake webcam, and drives octo·modern over HTTP and in Chromium: setup, adding servers, live temperatures over SSE, roles, uploads (including a 200 MB one, checking memory), printing, pausing, resuming and cancelling, webcam streaming and cleanup. It writes the screenshots in `docs/screenshots/` and removes its containers afterwards. `pnpm e2e:history` prints files to completion and cancels others on two virtual printers, with and without a browser watching, and checks the history entries (results, durations, who started them, pictures), the webhook notifications, CSV export, import, and the timelapses OctoPrint renders from the test camera (listing, Range requests, playback with seeking, download, delete, settings). Ports: `E2E_APP_PORT`, `E2E_OP_PORT_BASE`, `E2E_CAM_PORT`; `E2E_OP_PREFIX` names the containers (for both e2e scripts). `pnpm e2e:notify` (app `:3200`, OctoPrint `:3201`, camera `:3202`, mock services `:3204` HTTP and `:3205` SMTP) sets up one channel of every type against `scripts/e2e/mock-notify.mjs` (nothing real is contacted), sends tests including failing ones, prints on a virtual printer and checks the started, 50 %, finished (with snapshots: attachments, the shared link), still-hot, paused-by-M0, paused-by-the-operator and cancelled-by messages, offline and back by stopping the container, quiet hours, the delivery log and a backup round trip, then writes the `notifications*.png` screenshots. `pnpm e2e:mobile` (app `:3180`, OctoPrint `:5161`–`:5162`, camera `:5261`; same variables) opens every main page as an iPhone-sized touch screen at 360, 390 and 430 px and fails if anything sticks out sideways or a text field is under 16 px, then checks the drawer, the job bar and emergency-stop confirmation, the tab strip, the file list and its menu, the jog pad, the terminal prompt, the library and history sheets and the web app manifest, and writes the `mobile-*.png` screenshots. `pnpm e2e:power` (ports `:3230`–`:3236`) needs no Docker: it runs two mock OctoPrint servers powered by a mock Shelly Gen2 (Digest login) and a mock Tasmota, and checks plug setup and tests (admins only, sealed passwords), power-on with auto-connect, the hot and printing confirmations (in Chromium too), auto power-on for a print, the auto power-off countdown with Keep on and cancelling, the webhooks, the audit log and a 390 px phone, then writes the `power*.png` screenshots. The adapters are unit-tested against the same mocks (`scripts/e2e/mock-plugs.mjs`); nothing contacts a real device. `pnpm e2e:viewer` (app `:3250`, OctoPrint `:3251`–`:3252`, camera `:3253`) writes synthetic slicer-flavoured G-code (`node scripts/gcode-samples.mjs <dir> [--big MB]`: PrusaSlicer, Cura, OrcaSlicer with arcs, and comment-free files) plus a ~100 MB file (`E2E_BIG_MB`), checks the download routes (ranges, traversal, sign-in, no key in responses), previews printer and library files as a viewer (layers, legend, slider, keyboard, orbit, the 2D layer view), times the big file, follows a live print on a virtual printer and cross-checks the layer against OctoPrint's `filepos`, then checks the camera wall: live streams vs. snapshots, streams closing while the tab is hidden and while one camera is full screen, kiosk mode (whole window, cursor hiding, wake lock, rotation, bookmarkable URL) and one column at 390 px; it writes the `gcode-*.png`, `cameras*.png`, `mobile-gcode-preview.png` and `mobile-cameras.png` screenshots. It runs the full Chromium build so WebGL uses the real GPU (`E2E_SOFTWARE_GL=1` for SwiftShader). Measured on an Apple M4 with the 101 MB file (3.57 million moves, 784 layers): downloaded and parsed in about 0.6 s from a folder library and 0.9–1.4 s through OctoPrint (it runs on the same machine, in Docker), kept as 1.6 million points (39 MB JS heap); a full frame of 1.6 million segments draws within a 60 Hz frame, and orbiting stays at 60 fps. With a phone's budget (390 px touch emulation) it loads in about 0.6 s as 0.96 million points and 22 MB of heap. `pnpm e2e:stats` (app `:5300`, mock OctoPrint `:5301`–`:5303`, mock Spoolman `:5304`; no Docker) seeds about 14 months of deterministic demo history on three printers and a removed one, checks the totals and buckets against the seed, a viewer limited to one printer (also in the CSV), the CSV row count, the file links into the History and a 390 px phone without sideways scrolling, then writes `stats.png`, `stats-tables.png`, `stats-light.png` and `mobile-stats.png`. The home-screen icons in `static/` are rendered from the logo by `node scripts/pwa-icons.mjs`.

`pnpm e2e:bedmesh` (ports `:5400`–`:5403`) needs no Docker: `scripts/e2e/mock-octoprint.mjs` gains the Bed Visualizer plugin (its settings, the `@BEDLEVELVISUALIZER` probe run, its push messages over a small websocket) and the script checks detection (no tab and a settings hint without the plugin), the history from meshes probed in OctoPrint, roles, the refusal while printing and the confirmation, an update with progress in Chromium, the written-back mesh, the `bed.drift` webhook, comparing, deleting, light and dark, and a 390 px phone, then writes the `bedmesh*.png` and `mobile-bedmesh*.png` screenshots.

`pnpm e2e:discover` starts three OctoPrint servers on `:5151`–`:5153` and has octo·modern discover them through a mock Docker API (fictional containers, devices and networks pointing at the real ports, on `:5251`), a mock Arcane (`:5252`), a unicast mDNS responder (`OCM_MDNS_TARGET=127.0.0.1:5253`), the real local Docker socket (read-only) and a subnet scan of `127.0.0.1`. It runs the setup wizard in Chromium, adds printers through the Application Keys flow (approving and denying in OctoPrint by logging in to its API as its admin), pastes a key, moves a published port and relinks the saved printer, then writes the Discover screenshots and cleans up.

Requires Node 24+. The store uses the built-in `node:sqlite`, so there are no native modules. SFTP uses `ssh2` in pure JavaScript (its optional native addons are never built, see `pnpm.neverBuiltDependencies`), and SMB uses `smb3-client` with a few fixes for Samba compatibility and streaming in [`patches/`](patches/).

**Stack:** SvelteKit 3 · Svelte 5 · Tailwind CSS 4 · Node's built-in fetch and WebSocket. The look follows [Arcane](https://getarcane.app), like its sibling [pg·modern](https://github.com/vitafortis/pg-modern).

## License

[Apache-2.0](LICENSE). Copyright 2026 vitafortis.
