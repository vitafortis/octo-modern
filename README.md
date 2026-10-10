<p align="center">
  <img src="docs/logo.svg" width="64" height="64" alt="" />
</p>

<h1 align="center">octo·modern</h1>

<p align="center">
  A modern, self-hosted web UI for one or more OctoPrint servers.<br />
  Live state, webcams, files and jobs for every printer in one place, with the API keys kept on the server.
</p>

<p align="center">
  <img src="docs/screenshots/overview.png" alt="octo·modern overview" />
</p>

## Features

- **Every printer in one place**: add any number of OctoPrint servers. The sidebar shows each one's state (ready, printing, paused, error, unreachable) and progress; the overview shows the current file, progress, time left, ETA, temperatures and a webcam snapshot per printer. With a single printer, octo·modern opens straight to it.
- **Live, without hammering OctoPrint**: while you watch a printer, octo·modern keeps one push connection to OctoPrint (its SockJS websocket) and fans updates out to every browser over Server-Sent Events. Printers nobody is watching get a light status poll. If the websocket can't connect (a proxy without websocket support, say), it polls instead and keeps retrying with backoff.
- **Temperatures**: a live chart of actual and target temperatures per hotend, bed and chamber (5, 15 or 30 minutes), set targets directly or from OctoPrint's temperature presets, and turn everything off at once.
- **Jobs**: print, pause, resume, restart and cancel. Cancelling always asks first, from the dashboard, the printer header or the overview card.
- **Files**: browse OctoPrint's storage and the SD card with folders, sizes, upload dates, estimated print time, filament and the last print's outcome (and slicer thumbnails, if a thumbnail plugin provides them). Search and sort, drag and drop G-code to upload with progress, "print after upload", print or load any file, create folders, and delete (with confirmation). Uploads stream through octo·modern to OctoPrint without being held in memory, so files of hundreds of megabytes are fine.
- **Webcams**: the live MJPEG stream on the dashboard (with fullscreen) and its own tab, relayed by octo·modern so it works wherever octo·modern does, even when the camera is on a LAN address the browser can't reach. Several cameras per printer get a switcher; flip and rotation follow OctoPrint's settings; HLS and WebRTC cameras get an "Open stream" link.
- **Print history**: every print on every printer, recorded whether or not anyone has a browser open: file, start and end, duration, result (success, failed, cancelled), filament used, who started it, a webcam picture of how it ended, and notes. A History tab per printer and a History page across all of them, with filters, success rate, print time and filament per printer and per week, CSV export, and "print again". Earlier prints are imported from OctoPrint. See [Print history](#print-history).
- **Timelapses**: watch OctoPrint's timelapses in the browser (with seeking), download and delete them, render unrendered ones, and change the timelapse settings.
- **Notifications** when a print finishes, fails or is cancelled: ntfy, Discord or any webhook.
- **Connection**: connect and disconnect the printer with OctoPrint's ports, baud rates and printer profiles, and an emergency stop (M112).
- **API keys stay server-side**: keys are sealed with AES-256-GCM and never sent to a browser. Every request to OctoPrint, including the push connection, webcam images and uploads, goes through octo·modern.
- **Roles**: *admins* manage everything, *operators* run printers, *viewers* watch. Give people every printer or only some. See [Users and roles](#users-and-roles).
- **Audit log**: every print started, paused or cancelled, every temperature change, upload, deletion, G-code command and connection change, with who did it and from where.
- **Single sign-on**: any OIDC provider (Authentik, Authelia, Keycloak, Pocket ID, Google, …), with accounts created automatically for matching emails.
- **Status API for dashboards**: read-only tokens for Homepage, Glance, Uptime Kuma and Home Assistant. See [Dashboards and monitoring](#dashboards-and-monitoring).
- **Backup & restore**: an encrypted, passphrase-protected file with your printers (and their API keys), users and settings that restores on a fresh install.
- **Command palette**: `⌘K` (`Ctrl+K` on Linux/Windows) jumps to printers, tabs and pages.
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

The container runs as an unprivileged user and needs nothing but its `/data` volume. It doesn't use the Docker socket.

### Using Arcane?

Add `compose.yaml` as a new project in [Arcane](https://getarcane.app) and deploy it. Everything octo·modern stores lives in the `octo-modern-data` volume.

### Adding a printer

You need two things from each OctoPrint:

1. **Its URL, as octo·modern's server reaches it.** Usually `http://<pi-ip>` or `http://octopi.lan`. Behind a reverse proxy at a path, include the path (`https://print.example.com/octoprint`). Inside Docker, `localhost` is octo·modern's own container: use the host's IP, or `host.docker.internal` for an OctoPrint on the same Docker host. `.local` (mDNS) names usually don't resolve inside containers.
2. **An API key.** In OctoPrint, open **Settings → Application Keys** and generate one named "octo·modern", or copy a user's key from **User Settings → API key**. The key acts with the permissions of the OctoPrint user it belongs to, so a key of an admin user allows everything octo·modern does.

**Test connection** shows OctoPrint's version, which user the key belongs to, and any permission the key lacks. Self-signed certificate on your LAN? Turn off **Verify TLS certificate** for that server.

## Users and roles

| | Admin | Operator | Viewer |
| --- | --- | --- | --- |
| Watch printers: state, temperatures, webcam, files | ✓ | ✓ | ✓ |
| Start, pause, resume, cancel prints | ✓ | ✓ | |
| Set temperatures, connect/disconnect, G-code, emergency stop | ✓ | ✓ | |
| Upload, print and delete files | ✓ | ✓ | |
| Watch the print history and timelapses, export CSV | ✓ | ✓ | ✓ |
| Notes on prints, print again, delete and render timelapses | ✓ | ✓ | |
| Timelapse settings, delete history entries, import history, notifications | ✓ | | |
| Add, edit and remove printers (and their API keys) | ✓ | | |
| Users, Integrations, Audit log, Settings, backups | ✓ | | |

Operators and viewers see every printer, or only the ones you pick under **Users → Printers**. Printers someone hasn't been given don't exist as far as they can tell. Roles are enforced on the server for every route, not just hidden in the UI.

Dangerous actions ask for confirmation, and the server insists on it too (it answers `409` with `confirmRequired` until the request says `confirm: true`): cancelling a print, deleting a file, an emergency stop (M112), disconnecting during a print, and sending G-code while printing.

The first admin is created by the setup wizard, or headlessly with `OCM_ADMIN_EMAIL` and `OCM_ADMIN_PASSWORD`. Everyone can change their name, email and password under **My account** (click your name in the sidebar).

### OIDC

Set up single sign-on under **Integrations**, or with `OCM_OIDC_*` variables (see [Configuration](#configuration)). Register `<your-url>/auth/oidc/callback` as the redirect URI with your provider. People whose email matches **Create accounts automatically for** get an account on first sign-in, as admin if they also match **…as admin when matching**, otherwise with the default role (viewer, unless you choose operator). Once SSO works you can turn off password sign-in; `OCM_LOCAL_LOGIN=enabled` brings it back if SSO breaks.

## Webcams

octo·modern reads each printer's cameras from OctoPrint's webcam settings: the classic webcam and any camera a webcam plugin adds. Relative URLs like `/webcam/?action=stream` are resolved against the OctoPrint URL. To use a different camera, put its stream or snapshot URL in the server's **Webcam** field; it wins over OctoPrint's settings.

- **MJPEG** streams (mjpg-streamer, ustreamer, camera-streamer's MJPEG endpoint) are relayed through octo·modern, with snapshots for the overview cards. The relay applies backpressure and closes the camera connection as soon as the last viewer leaves; streams pause while the page is hidden.
- **HLS and WebRTC** streams can't be relayed as an image; octo·modern shows a snapshot (if there is one) and an **Open stream** link, which the browser must be able to reach.

## Files and uploads

The **Files** tab lists OctoPrint's local storage and, when the printer has one, its SD card. Uploads go to local storage (OctoPrint can copy files to the SD card itself). The upload is streamed to OctoPrint as it arrives, so octo·modern's memory use doesn't grow with the file; the image allows uploads up to 4 GB (`BODY_SIZE_LIMIT`). A reverse proxy in front of octo·modern may have its own limit (nginx: `client_max_body_size`).

## Print history

octo·modern records each print itself, from the live state it already keeps:

- **Nobody watching**: the background status poll (`OCM_POLL_INTERVAL_MS`, 10 s) sees a printer start printing and opens a history entry. From then until the print ends, octo·modern holds OctoPrint's push connection open for that printer (one websocket per *printing* printer; idle printers are only polled). The end then arrives as OctoPrint's own `PrintDone`, `PrintFailed` or `PrintCancelled` event, with the exact result and print time. Should the push connection be unavailable (a proxy without websockets), the printer is polled every 2 s instead, and the outcome is read from the state change (100 % done, an error, a "Cancelling" in between) and OctoPrint's record of the file's last print.
- **Someone watching**: the push connection is open anyway; the same events end the entry.
- **octo·modern restarts mid-print**: the open entry continues when the printer is next seen printing the same file, or is closed with OctoPrint's record of how it ended.

A print shorter than one poll interval, started and finished while nobody watched and no other print was running, can be missed; lower `OCM_POLL_INTERVAL_MS` if that matters. Prints started through octo·modern show who started them (from the audit log); others say "OctoPrint". Filament used is the slicer's estimate scaled by how far the print got. The picture is a webcam snapshot taken as the print ends (the slicer's thumbnail when there's no camera), scaled down to at most 100 KB.

**Importing**: the first time a printer is reachable, octo·modern imports its earlier prints once: every print the [PrintJobHistory](https://plugins.octoprint.org/plugins/PrintJobHistory/) plugin recorded, if it's installed, otherwise the last print of each file from OctoPrint's file statistics (OctoPrint counts a cancel as a failure there, so those come in as failed). Admins can import again from the History page; prints already recorded aren't duplicated.

**Notifications**: admins add channels under **History → Notifications**: [ntfy](https://ntfy.sh) (topic, optional token), a Discord webhook, or a generic webhook, each for finished, failed and/or cancelled prints, with a test button. Webhook URLs and tokens are stored encrypted. A generic webhook receives a JSON `POST`:

```json
{
  "source": "octo-modern", "version": 1, "event": "failed",
  "title": "Print failed: benchy.gcode",
  "message": "Prusa MK4: benchy.gcode failed after 1h 02m, at 42%, 1.50 m filament, reason: error.",
  "printer": { "id": "…", "name": "Prusa MK4" },
  "print": { "id": 12, "file": "benchy.gcode", "path": "parts/benchy.gcode", "startedAt": "…", "endedAt": "…", "durationS": 3720, "filamentMm": 1500, "completion": 42, "startedBy": "Otto", "reason": "error" },
  "at": "…", "url": "http://octo-modern.lan:3040/p/…?tab=history"
}
```

`GET /api/history/export.csv` (signed in) returns the history as CSV, with the same filters as the page (`printer`, `result`, `from`, `to`, `q`).

## Timelapses

The **Timelapse** tab lists OctoPrint's rendered timelapses with their thumbnails, plays them in the browser and downloads them. octo·modern relays the videos with HTTP Range requests passed through, so the player can seek without downloading the whole file, and the browser never needs to reach OctoPrint. Operators delete timelapses and render or delete unrendered ones; admins change the settings (off, on each layer change, or timed; frame rate, interval, post-roll). OctoPrint needs a webcam snapshot URL and ffmpeg to record timelapses (the `octoprint/octoprint` image has ffmpeg).

## Dashboards and monitoring

Create a token under **Integrations → Status API tokens** (admins). It's shown once; only its SHA-256 is stored. Tokens can expire, can be revoked, and record when they were last used. They open these routes only, and only for `GET`. They're never accepted as a session anywhere else.

| Route | Returns |
| --- | --- |
| `GET /api/status` | `{ printers, online, printing, checkedAt, items: [...] }` |
| `GET /api/status/<id>` | one item; add `?strict=1` to get HTTP 503 while it's unreachable or in an error state |
| `GET /api/status/badge/<id>.svg` | a shields-style badge, e.g. `printing 42%` (`?label=` sets the left text) |

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
| ![History](docs/screenshots/history.png) | ![History, light](docs/screenshots/history-light.png) |
| **History**: every print, stats per printer and week | **History**, light |
| ![A print in the history](docs/screenshots/history-entry.png) | ![Printer history](docs/screenshots/printer-history.png) |
| **A print**: how it ended, notes, print again | **History tab** of one printer |
| ![Timelapse player](docs/screenshots/timelapse-player.png) | ![Timelapses, light](docs/screenshots/timelapse-light.png) |
| **Timelapse**: play with seeking, download | **Timelapse settings**, light |
| ![Settings](docs/screenshots/settings.png) | ![Sign in](docs/screenshots/login.png) |
| **Settings**: security and backup | **Sign in** |

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `OCM_DATA_DIR` | `./data` (`/data` in the image) | Encrypted SQLite store and key file |
| `OCM_SECRET_KEY` | — | Master secret. Unset means a random key is generated in `secret.key` |
| `OCM_ADMIN_EMAIL`, `OCM_ADMIN_PASSWORD`, `OCM_ADMIN_NAME` | — | Create the first admin on start instead of using the setup wizard |
| `OCM_AUTH` | — | `disabled` skips the login screen (trusted networks only) |
| `OCM_LOCAL_LOGIN` | — | `disabled` hides the email/password form (SSO only); `enabled` forces it back on |
| `OCM_OIDC_ISSUER` | — | OIDC issuer URL; enables SSO (or configure it under Integrations) |
| `OCM_OIDC_CLIENT_ID`, `OCM_OIDC_CLIENT_SECRET` | — | Client credentials from your identity provider |
| `OCM_OIDC_NAME` | `SSO` | Login button label |
| `OCM_OIDC_SCOPES` | `openid email profile` | Requested scopes |
| `OCM_OIDC_AUTO_CREATE` | — | Emails that get an account on first login: `*@example.com`, `bob@gmail.com`, `*` |
| `OCM_OIDC_ADMIN_EMAILS` | — | Auto-created accounts matching these become admins |
| `OCM_OIDC_DEFAULT_ROLE` | `viewer` | Role for other auto-created accounts (`viewer` or `operator`) |
| `OCM_OIDC_REDIRECT_URI` | `<origin>/auth/oidc/callback` | Override when the public URL can't be inferred |
| `OCM_POLL_INTERVAL_MS` | `10000` | Status poll for printers nobody is watching live |
| `OCM_REQUEST_TIMEOUT_MS` | `10000` | Timeout for each request to OctoPrint |
| `OCM_PUSH_THROTTLE` | `2` | Live updates arrive every 500 ms × this |
| `OCM_TEMP_HISTORY_MINUTES` | `30` | Temperature history kept in memory per printer |
| `BODY_SIZE_LIMIT` | `4G` in the image | Largest upload |
| `TZ` | `UTC` | Time zone for logs |
| `PROTOCOL_HEADER`, `HOST_HEADER` | — | Set to `x-forwarded-proto` / `x-forwarded-host` behind a TLS reverse proxy |

## Backup & restore

Under **Settings → Backup & restore**, admins download an encrypted file with printers (and their API keys), users (roles, password hashes, SSO links, printer access) and settings (single sign-on). It's sealed with a passphrase you choose, not the master key, so it restores on a new install. A restore shows what it will add or update before applying; printers are matched by id and users by email, nothing is deleted, and your own account is never changed. The audit log, print history and API tokens aren't included.

## Security model

- **API keys** are sealed with AES-256-GCM, bound to their printer's id, and never sent to the browser, not even to admins. The SQLite file and key file are created with mode `0600`. Back up `secret.key`, or set `OCM_SECRET_KEY`; without it, stored keys can't be recovered.
- **The browser never talks to OctoPrint.** Status, the push connection, webcam images and streams, thumbnails and uploads all go through octo·modern. Camera URLs of relayed cameras aren't sent to the browser either. A camera request carries the API key only when the camera is on OctoPrint's own origin.
- **Least privilege**: an OctoPrint Application Key acts as the user who approved it. Use a key of a user with only the permissions you want octo·modern to have; **Test connection** lists what it lacks.
- **Access** is checked on the server for every printer-scoped page and API call. Viewers can't reach any route that changes a printer; operators can't reach server, user or settings routes. Confirmations for dangerous actions are enforced by the server.
- **API tokens** (`ocm_` + 32 random bytes, SHA-256 hashed at rest) only work on `GET /api/status…`; they never become sessions, and repeated bad tokens from one address are throttled. Status responses omit OctoPrint URLs unless the token allows it, and report errors as codes only.
- **Sign-in** is by OIDC or by local accounts (scrypt-hashed passwords, login throttle). Sessions are httpOnly cookies tied to a user and end when the user is disabled or their role changes. Writes from another origin are rejected.
- **Backup files** hold decrypted API keys and the SSO client secret, re-encrypted with AES-256-GCM under a key derived from your passphrase (scrypt). Treat the file and its passphrase like a password manager export.

## Development

```sh
pnpm install
pnpm dev                              # http://localhost:3040
pnpm check && pnpm test               # types + unit tests
scripts/dev-octoprint.sh up 2         # two OctoPrint servers with virtual printers on :5101, :5102
node scripts/mjpeg-source.mjs 5190    # a fake MJPEG webcam on :5190
pnpm e2e                              # end-to-end against real OctoPrint containers (needs Docker)
pnpm e2e:history                      # print history, notifications and timelapses end to end
```

`scripts/dev-octoprint.sh` starts `octoprint/octoprint` containers with the built-in Virtual Printer enabled, the first-run wizard skipped and an admin user (`admin` / `octoprint-dev`) whose API key is `ocm-dev-key-<n>`; `env` prints their URLs and keys, `down` removes them. `pnpm e2e` builds the app, starts two such servers and the fake webcam, and drives octo·modern over HTTP and in Chromium: setup, adding servers, live temperatures over SSE, roles, uploads (including a 200 MB one, checking memory), printing, pausing, resuming and cancelling, webcam streaming and cleanup. It writes the screenshots in `docs/screenshots/` and removes its containers afterwards. `pnpm e2e:history` prints files to completion and cancels others on two virtual printers, with and without a browser watching, and checks the history entries (results, durations, who started them, pictures), the webhook notifications, CSV export, import, and the timelapses OctoPrint renders from the test camera (listing, Range requests, playback with seeking, download, delete, settings). Ports: `E2E_APP_PORT`, `E2E_OP_PORT_BASE`, `E2E_CAM_PORT`; `E2E_OP_PREFIX` names the containers (for both e2e scripts).

Requires Node 24+. The store uses the built-in `node:sqlite`, so there are no native modules.

**Stack:** SvelteKit 3 · Svelte 5 · Tailwind CSS 4 · Node's built-in fetch and WebSocket. The look follows [Arcane](https://getarcane.app), like its sibling [pg·modern](https://github.com/vitafortis/pg-modern).
