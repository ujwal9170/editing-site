export function cleanVideoName(name) {
  return String(name || "")
    .replace(/^Video by\s+/i, "")
    .trim();
}
