// Truncate a string in the middle, keeping `maxLen - 1` chars total (the
// dropped middle becomes a single `…`). The head gets the extra char on
// odd budgets so the visible host + path of a URL stays as readable as
// possible while the dense query string in the middle collapses.
export const truncateMiddle = (s: string, maxLen = 80): string => {
  if (s.length <= maxLen) return s;
  const keep = maxLen - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
};
