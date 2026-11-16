# Adds the public key in $1 to ~/.ssh/authorized_keys, once (ADR-0012),
# making ~/.ssh (0700) and the file (0600) when they're missing; what's there
# keeps its permissions. It runs in `sh`, whatever the login shell is.
set -e
key=$1
dir=$HOME/.ssh
file=$dir/authorized_keys
umask 077
[ -d "$dir" ] || mkdir "$dir"
type=$(printf '%s\n' "$key" | cut -d ' ' -f 1)
blob=$(printf '%s\n' "$key" | cut -d ' ' -f 2)
# Only a line that isn't commented out lets the key in.
if [ -f "$file" ] && awk -v t="$type" -v b="$blob" '
  $1 !~ /^#/ { for (i = 1; i < NF; i++) if ($i == t && $(i + 1) == b) found = 1 }
  END { exit !found }' "$file"; then
  echo icmm:key-added
  exit 0
fi
# A last line without its newline would run into the key.
if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then
  echo >> "$file"
fi
printf '%s\n' "$key" >> "$file"
echo icmm:key-added
