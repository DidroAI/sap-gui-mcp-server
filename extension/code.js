// Pairing code helpers, shared by the service worker and the popup.

// PROTOCOL.md: uppercase, Crockford look-alikes mapped (I, L -> 1, O -> 0),
// everything outside [0-9A-Z] removed. The HMAC key is the UTF-8 of this.
export function normalizeCode(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/[^0-9A-Z]/g, "");
}

export const CODE_LENGTH = 26;

// ABCDE-FGHJK-MNPQR-STVWX-YZ012-3
export function formatCode(code) {
  return normalizeCode(code).replace(/(.{5})(?=.)/g, "$1-");
}
