#!/usr/bin/env bash
# Validates the marketplace and every mod it lists, runs each mod's tests, and
# flags a mod folder the marketplace does not list.
# A failing step does not stop the run: every mod is checked, and what failed is
# named at the end.
set -u

root=$(cd -- "$(dirname -- "$0")/.." && pwd)
marketplace="$root/.claude-plugin/marketplace.json"
failed=''
listed=()

fail() { failed="${failed}${failed:+; }$1"; }

# The marketplace's plugin entries, one "<name><tab><source>" line each. Read with sed so the
# script needs nothing but a shell: every entry in this manifest is a flat object of strings.
plugins_of() {
  tr -d '\n\r' <"$1" |
    sed -e 's/.*"plugins"[[:space:]]*:[[:space:]]*\[//' -e 's/\].*//' |
    tr '}' '\n' |
    while IFS= read -r entry; do
      case $entry in
      *'"name"'*) ;;
      *) continue ;;
      esac
      printf '%s\t%s\n' \
        "$(printf '%s' "$entry" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')" \
        "$(printf '%s' "$entry" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    done
}

is_listed() {
  local one
  for one in ${listed+"${listed[@]}"}; do
    [ "$one" = "$1" ] && return 0
  done

  return 1
}

command -v claude >/dev/null 2>&1 || {
  echo 'check: claude is not on the PATH' >&2
  exit 1
}

[ -f "$marketplace" ] || {
  echo "check: no marketplace manifest at $marketplace" >&2
  exit 1
}

entries=$(plugins_of "$marketplace")

[ -n "$entries" ] || {
  echo "check: no plugins read from $marketplace" >&2
  exit 1
}

claude plugin validate "$root" || fail 'marketplace'

# Fed by a here-document, not a pipe: a pipe would run the loop in a subshell and lose what it found.
while IFS=$'\t' read -r name source; do
  [ -n "$name" ] || continue

  if [ ! -d "$root/$source" ]; then
    fail "$name: $source does not exist"
    continue
  fi

  dir=$(cd -- "$root/$source" && pwd)
  listed+=("$dir")

  claude plugin validate "$dir" || fail "$name: validate"

  tests=$(find "$dir" -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) '!' -path '*/.claude-plugin/*')
  if [ -n "$tests" ]; then
    claude plugin test "$dir" || fail "$name: test"
  fi
done <<EOF
$entries
EOF

# A mod folder the marketplace does not list cannot be installed.
for dir in "$root"/*/; do
  dir=${dir%/}
  [ -f "$dir/.claude-plugin/plugin.json" ] || continue
  is_listed "$dir" || fail "$(basename -- "$dir"): not listed in marketplace.json"
done

if [ -n "$failed" ]; then
  echo "Failed: $failed" >&2
  exit 1
fi

echo 'All mods passed.'
