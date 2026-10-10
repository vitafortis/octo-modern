#!/usr/bin/env bash
# Throwaway OctoPrint servers with the built-in Virtual Printer, for development and e2e tests.
#
#   scripts/dev-octoprint.sh up [N]     start N servers (default 1), wait until they answer, connect the virtual printer
#   scripts/dev-octoprint.sh down       remove the containers and their volumes
#   scripts/dev-octoprint.sh status     list them
#   scripts/dev-octoprint.sh env        print base URLs and API keys as KEY=value lines
#
# Server i (1-based) listens on http://127.0.0.1:$((OCM_OP_PORT_BASE + i - 1)) and accepts the API key
# "$OCM_OP_KEY_PREFIX$i" (a user API key of the admin user "admin", password "octoprint-dev").
#
# Options (environment):
#   OCM_OP_PORT_BASE    first host port            (default 5101)
#   OCM_OP_PREFIX       container/volume prefix    (default octo-modern-dev-op)
#   OCM_OP_KEY_PREFIX   API key prefix             (default ocm-dev-key-)
#   OCM_OP_IMAGE        image                      (default octoprint/octoprint:latest)
#   OCM_OP_CONNECT=0    don't connect the virtual printer after start
set -euo pipefail

PORT_BASE=${OCM_OP_PORT_BASE:-5101}
PREFIX=${OCM_OP_PREFIX:-octo-modern-dev-op}
KEY_PREFIX=${OCM_OP_KEY_PREFIX:-ocm-dev-key-}
IMAGE=${OCM_OP_IMAGE:-octoprint/octoprint:latest}
CONNECT=${OCM_OP_CONNECT:-1}
ADMIN_USER=admin
ADMIN_PASSWORD=octoprint-dev

# Writes config.yaml and users.yaml into the basedir with OctoPrint's own Python, so the
# password hash uses whatever hasher this OctoPrint version expects.
seed_py() {
	cat <<'PY'
import os, sys, yaml
from octoprint.access.users import UserManager
base, key, user, password = sys.argv[1:5]
os.makedirs(base, exist_ok=True)
config = {
    "server": {
        "firstRun": False,
        "onlineCheck": {"enabled": False},
        "pluginBlacklist": {"enabled": False},
        "seenWizards": {"corewizard": 4, "backup": None, "tracking": None},
    },
    "api": {"allowCrossOrigin": False},
    "plugins": {
        "virtual_printer": {"enabled": True},
        "tracking": {"enabled": False},
        "errortracking": {"enabled": False},
        "announcements": {"enabled_channels": []},
        "softwareupdate": {"check_overlay_url": None},
    },
    "serial": {"autoconnect": False, "port": "VIRTUAL", "baudrate": 0},
    # A few custom controls (Control tab): a section with a command, a slider input and feedback.
    "controls": [
        {
            "name": "Lights",
            "layout": "horizontal",
            "children": [
                {"name": "Lights on", "command": "M42 P8 S255"},
                {"name": "Set brightness", "command": "M42 P8 S%(brightness)s", "input": [{"name": "Brightness", "parameter": "brightness", "default": 128, "slider": {"min": 0, "max": 255}}]},
            ],
        },
        {
            "name": "Diagnostics",
            "children": [
                {"name": "Report position", "command": "M114"},
                {"name": "Position", "regex": "X:([-\\d.]+) Y:([-\\d.]+) Z:([-\\d.]+)", "template": "X {0} · Y {1} · Z {2}"},
            ],
        },
    ],
    "temperature": {
        "profiles": [
            {"name": "PLA", "extruder": 200, "bed": 60, "chamber": None},
            {"name": "PETG", "extruder": 235, "bed": 80, "chamber": None},
            {"name": "ABS", "extruder": 245, "bed": 100, "chamber": None},
        ]
    },
}
with open(os.path.join(base, "config.yaml"), "w") as f:
    yaml.safe_dump(config, f)
users = {
    "_version": 2,
    user: {
        "password": UserManager.create_password_hash(password),
        "active": True,
        "groups": ["admins", "users"],
        "permissions": [],
        "apikey": key,
        "settings": {},
        "roles": ["user", "admin"],
    },
}
with open(os.path.join(base, "users.yaml"), "w") as f:
    yaml.safe_dump(users, f)
PY
}

names() { docker ps -a --filter "name=^${PREFIX}[0-9]+$" --format '{{.Names}}' | sort; }

up() {
	local n=${1:-1}
	for i in $(seq 1 "$n"); do
		local name="$PREFIX$i" port=$((PORT_BASE + i - 1)) key="$KEY_PREFIX$i"
		docker rm -f "$name" >/dev/null 2>&1 || true
		docker volume rm "$name" >/dev/null 2>&1 || true
		docker volume create "$name" >/dev/null
		# Seed the volume before the first start (the image's own files land in it too).
		docker run --rm -v "$name:/octoprint" --entrypoint python "$IMAGE" -c "$(seed_py)" /octoprint/octoprint "$key" "$ADMIN_USER" "$ADMIN_PASSWORD"
		docker run -d --name "$name" -v "$name:/octoprint" -p "127.0.0.1:$port:80" --label octo-modern.dev=1 "$IMAGE" >/dev/null
		echo "• $name starting on http://127.0.0.1:$port (key $key)"
	done
	for i in $(seq 1 "$n"); do
		local port=$((PORT_BASE + i - 1)) key="$KEY_PREFIX$i"
		local ok=0
		for _ in $(seq 1 120); do
			if curl -fsS -H "X-Api-Key: $key" "http://127.0.0.1:$port/api/version" >/dev/null 2>&1; then
				ok=1
				break
			fi
			sleep 1
		done
		if [ "$ok" != 1 ]; then
			echo "✗ $PREFIX$i did not come up; docker logs $PREFIX$i" >&2
			exit 1
		fi
		if [ "$CONNECT" = 1 ]; then
			curl -fsS -X POST -H "X-Api-Key: $key" -H 'Content-Type: application/json' \
				-d '{"command":"connect","port":"VIRTUAL","baudrate":0,"autoconnect":false}' "http://127.0.0.1:$port/api/connection" >/dev/null
		fi
		echo "✓ $PREFIX$i ready: $(curl -fsS -H "X-Api-Key: $key" "http://127.0.0.1:$port/api/version")"
	done
}

down() {
	for name in $(names); do
		docker rm -f "$name" >/dev/null
		docker volume rm "$name" >/dev/null 2>&1 || true
		echo "• removed $name"
	done
}

status() { docker ps -a --filter "name=^${PREFIX}[0-9]+$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'; }

env_lines() {
	local i=0
	for name in $(names); do
		i=$((i + 1))
		local n=${name#"$PREFIX"}
		echo "OCTOPRINT_${n}_URL=http://127.0.0.1:$((PORT_BASE + n - 1))"
		echo "OCTOPRINT_${n}_KEY=$KEY_PREFIX$n"
	done
}

case "${1:-}" in
	up) up "${2:-1}" ;;
	down) down ;;
	status) status ;;
	env) env_lines ;;
	*)
		sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
		exit 1
		;;
esac
