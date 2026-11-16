# Installs the engine bundle whose archive arrives on stdin (src/engine/remote.rs):
# `sh <this> <engine root> <key> <archive sha256> <bytes already sent> <interpreter> <archive bytes>`.
# The archive lands in .incoming/<sha256>.tar.zst.part, so a cut upload resumes;
# it's checked, unpacked into a staging folder, self-checked, then renamed to
# <key>, the commit. Its last line on stdout is `icmm:installed` or
# `icmm:failed <why> <detail>`. POSIX sh only.
root=$1
key=$2
sha=$3
offset=$4
python=$5
total=$6
lock="$root/.lock"
part="$root/.incoming/$sha.tar.zst.part"
stage="$root/.staging-$$"

fail() {
  echo "icmm:failed $*"
  exit 1
}

# One install at a time. A lock is left by a cut install when its owner, on
# this login node, is gone, or after 15 minutes, the desktop's limit on one.
owner=""
[ -f "$lock/owner" ] && owner=$(cat "$lock/owner" 2>/dev/null)
here=$(hostname)
stale=$(find "$lock" -prune -mmin +15 2>/dev/null)
if [ -z "$stale" ] && [ "${owner%:*}" = "$here" ] && [ -n "${owner#*:}" ]; then
  kill -0 "${owner#*:}" 2>/dev/null || stale=yes
fi
if mkdir "$lock" 2>/dev/null; then
  :
elif [ -n "$stale" ] && rm -rf "$lock" && mkdir "$lock"; then
  :
else
  fail busy
fi
echo "$here:$$" > "$lock/owner"
trap 'rm -rf "$stage" "$lock"' EXIT
trap 'exit 1' HUP INT TERM
# Holding the lock, any other staging folder is a cut install's.
rm -rf "$root"/.staging-*

if [ -f "$root/$key/BUNDLE.json" ]; then
  echo "icmm:installed"
  exit 0
fi
# A folder without its BUNDLE.json isn't an install: set it aside.
[ -e "$root/$key" ] && mv "$root/$key" "$root/.staging-$$-broken"

[ "$offset" = 0 ] && : > "$part"
[ "$(wc -c < "$part" | tr -d ' ')" = "$offset" ] || fail moved
cat >> "$part" || fail space

size=$(wc -c < "$part" | tr -d ' ')
# A cut upload keeps what arrived, for the next connect to resume.
[ "$size" -lt "$total" ] && fail cut "$size of $total bytes arrived"
sum=$( (sha256sum "$part" 2>/dev/null || shasum -a 256 "$part") | cut -d ' ' -f 1)
if [ "$sum" != "$sha" ]; then
  rm -f "$part"
  fail damaged
fi

mkdir -p "$stage/$key" || fail space
if zstd -dcq "$part" | tar -xf - -C "$stage/$key" 2>"$stage/tar.err"; then
  :
else
  fail unpack "$(tail -n 1 "$stage/tar.err")"
fi
check=$("$stage/$key/$python" -I -m icmm selfcheck 2>&1) ||
  fail selfcheck "$(printf '%s\n' "$check" | tail -n 1)"
mv "$stage/$key" "$root/$key" || fail commit
rm -f "$part" "$0"
echo "icmm:installed"
