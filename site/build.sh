#!/bin/sh
# Assembles the GitHub Pages site: site/ plus the app's own screenshots and logo from docs/,
# so the site always shows what the README shows. No dependencies beyond a POSIX shell.
#
#   site/build.sh            -> site/_site
#   site/build.sh <out-dir>
#
# Absolute URLs in the pages (canonical, Open Graph) and the sitemap use SITE_URL, set below in
# one place (or from the environment): change it when the site moves to its own domain.
#
# Preview: site/build.sh && python3 -m http.server -d site/_site 8080
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
out=${1:-"$here/_site"}
SITE_URL=${SITE_URL:-https://vitafortis.github.io/octo-modern}
SITE_URL=${SITE_URL%/}

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

# The pages say %SITE_URL% where they need the absolute address.
for page in "$out"/*.html; do
	sed "s#%SITE_URL%#$SITE_URL#g" "$page" >"$page.tmp" && mv "$page.tmp" "$page"
done

printf 'User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n' "$SITE_URL" >"$out/robots.txt"
today=$(date -u +%Y-%m-%d)
{
	echo '<?xml version="1.0" encoding="UTF-8"?>'
	echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
	for path in "" docs.html; do
		echo "  <url><loc>$SITE_URL/$path</loc><lastmod>$today</lastmod></url>"
	done
	echo '</urlset>'
} >"$out/sitemap.xml"

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
