#!/bin/bash
# lda-drive-watchdog.sh — runs under launchd every 120s on the M4.
#
# The 15TB USB "Media" drive (Plex library + this app's transcode cache) dropped
# off the bus on 2026-06-11 after 17 days up, taking Plex + the portal down. This
# watchdog:
#   1. KEEPS the drive healthy by detection (prevention is the pmset disksleep=0
#      setting — see CLAUDE.md; software can't keep an HDD spun up without Full
#      Disk Access, which we deliberately avoid here).
#   2. AUTO-REMOUNTS it if it merely unmounted but is still on the USB bus.
#   3. ALERTS (Pushover) + captures diagnostics if it fully de-enumerated — which
#      macOS cannot recover in software (needs a physical reconnect/power-cycle).
#
# Health is checked via the mount table + `diskutil` ONLY — it never reads files
# on the volume, so (unlike the transcode helper) it needs NO Full Disk Access.
set -uo pipefail

VOL="/Volumes/Media"
UUID="93C743F8-9A62-4B89-B046-8B0E7D5E80E3"   # APFS "Media" volume — stable across re-enumeration
LOGDIR="$HOME/Library/Logs"
LOG="$LOGDIR/lda-drive-watchdog.log"
STATE="$LOGDIR/.lda-drive-state"
[ -r "$HOME/.config/fleet-secrets.env" ] && . "$HOME/.config/fleet-secrets.env" 2>/dev/null

ts(){ date -u +%FT%TZ; }
logw(){ echo "$(ts) $*" >> "$LOG"; }
notify(){ # $1=message  $2=priority(0/1)
  if [ -z "${PUSHOVER_API_TOKEN:-}" ] || [ -z "${PUSHOVER_USER_KEY:-}" ]; then logw "no pushover creds; skip notify"; return 0; fi
  curl -s --max-time 10 https://api.pushover.net/1/messages.json \
    -F token="$PUSHOVER_API_TOKEN" -F user="$PUSHOVER_USER_KEY" \
    -F title="M4 Media drive" -F "message=$1" -F priority="${2:-0}" >/dev/null 2>&1
}

# One-off: `lda-drive-watchdog.sh test` confirms the Pushover pipeline.
if [ "${1:-}" = "test" ]; then notify "✅ watchdog test — Pushover is wired up." 0; echo "test notification sent"; exit 0; fi

mounted(){ mount | grep -q " on $VOL (" && diskutil info "$UUID" 2>/dev/null | grep -E "^[[:space:]]*Mounted:" | grep -q "Yes"; }

prev="$(cat "$STATE" 2>/dev/null)"

if mounted; then
  [ "$prev" = "down" ] && { logw "drive recovered"; notify "✅ Media drive back online." 0; }
  echo up > "$STATE"
  exit 0
fi

logw "Media not mounted — investigating"
# Capture evidence before the unified log rolls (it retains only recent history
# on this busy box — that's why last night's cause was unrecoverable).
DIAG="$LOGDIR/lda-drive-incident-$(date +%Y%m%d-%H%M%S).log"
{
  echo "### incident $(ts)"
  echo "## mount";              mount
  echo "## diskutil list";      diskutil list
  echo "## diskutil info UUID"; diskutil info "$UUID" 2>&1
  echo "## pmset -g";           pmset -g
  echo "## unified log: USB/disk, last 10m"
  log show --last 10m --predicate 'eventMessage CONTAINS[c] "usb" OR eventMessage CONTAINS "disk" OR eventMessage CONTAINS[c] "AppleUSB" OR eventMessage CONTAINS[c] "media"' 2>/dev/null | tail -300
} > "$DIAG" 2>&1
logw "diagnostics saved: $DIAG"

# Still enumerated but unmounted? Remount it (no sudo needed; Owners disabled).
if diskutil info "$UUID" >/dev/null 2>&1; then
  logw "volume present but unmounted — attempting remount"
  if diskutil mount "$UUID" >> "$LOG" 2>&1 && mounted; then
    logw "auto-remounted OK"
    notify "✅ Media drive had unmounted; auto-remounted it." 0
    echo up > "$STATE"
    exit 0
  fi
  logw "remount attempt failed"
fi

# Fully de-enumerated — macOS can't re-enumerate a dropped USB device in software.
if [ "$prev" != "down" ]; then
  notify "⚠️ Media drive DROPPED off the M4 and isn't detectable — needs a physical reconnect/power-cycle. Plex + downloads are down until then. Diag: $(basename "$DIAG")" 1
  logw "alerted: de-enumerated, physical reconnect required"
fi
echo down > "$STATE"
exit 0
