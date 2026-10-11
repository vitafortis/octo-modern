#!/bin/sh
# Assembles the GitHub Pages site: site/ plus the app's own screenshots and logo from docs/,
# so the site always shows what the README shows. No dependencies beyond a POSIX shell.
#
#   site/build.sh            -> site/_site
#   site/build.sh <out-dir>
#
# Preview: site/build.sh && python3 -m http.server -d site/_site 8080
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
out=${1:-"$here/_site"}

rm -rf "$out"
mkdir -p "$out/screenshots"

# The site's own files (pages, CSS, JS, fonts, og image); not the tooling or the output itself.
for f in "$here"/*; do
	case "$(basename "$f")" in
		_site | tools | build.sh | README.md) ;;
		*) cp -R "$f" "$out/" ;;
	esac
done

cp "$repo"/docs/screenshots/*.png "$out/screenshots/"
cp "$repo/docs/logo.svg" "$out/logo.svg"
touch "$out/.nojekyll"

# Fail the build if a page references a screenshot that docs/screenshots no longer has.
missing=0
for ref in $(grep -oh 'screenshots/[A-Za-z0-9._-]*\.png' "$out"/*.html | sort -u); do
	if [ ! -f "$out/$ref" ]; then
		echo "missing: $ref (referenced by the site, not in docs/screenshots)" >&2
		missing=1
	fi
done
[ "$missing" -eq 0 ] || exit 1

echo "site assembled in $out"
