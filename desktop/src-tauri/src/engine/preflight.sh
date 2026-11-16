# What an engine install needs to know of an SSH platform, in one exec
# (src/engine/remote.rs): `sh -s -- <engine root> <archive sha256>`, with this
# script on stdin. It also leaves the install script for the next exec.
# POSIX sh only; it must run on any cluster's login node.
root=$1
sha=$2
mkdir -p "$root/.incoming" || exit 1
cat > "$root/.incoming/$sha.sh" <<'ICMM_INSTALL'
@INSTALL_SH@
ICMM_INSTALL
echo "uname=$(uname -sm)"
echo "glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null)"
command -v zstd >/dev/null 2>&1 && echo "zstd=yes"
part="$root/.incoming/$sha.tar.zst.part"
[ -f "$part" ] && echo "part=$(wc -c < "$part" | tr -d ' ')"
echo "df=$(df -Pk "$root" | tail -n 1)"
limit=""
command -v timeout >/dev/null 2>&1 && limit="timeout 10"
$limit quota -w 2>/dev/null | sed "s/^/quota=/"
exit 0
