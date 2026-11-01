/**
 * Shown for a value that the browser does not report
 */
export const NO_VALUE = "—";

export const formatBitrate = (bitsPerSecond: number | null): string => {
  if (bitsPerSecond == null) {
    return NO_VALUE;
  }

  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`
    : `${Math.round(bitsPerSecond / 1000)} kbps`;
};

/**
 * Formats a duration as "m:ss", rounded up, so that "0:00" only shows when the time is up.
 */
export const formatCountdown = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};
