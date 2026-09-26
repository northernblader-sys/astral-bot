/**
 * formatTimeLeft(ms) -> "2h 14m" / "45m 12s" / "38s" / "ended"
 * Always shows the two most significant non-zero units (falling to
 * one unit — seconds — when under a minute) so remaining time reads
 * as a live countdown, not a single flattened/rounded number.
 */
export function formatTimeLeft(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'ended'
  const totalSeconds = Math.ceil(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
