/**
 * Local-time ISO 8601 formatting, vendored so this package has no dependency on
 * the sibling time-logger code (it is meant to be extracted into its own
 * OpenCode plugin). Keep in sync with the copy in the time-logger src if that
 * ever matters — but they are intentionally independent.
 */

/**
 * Local-time ISO 8601 string with offset, e.g. 2026-06-17T11:53:34+03:00.
 * @param {number} ms
 * @returns {string}
 */
export function toIso(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    offset
  );
}
