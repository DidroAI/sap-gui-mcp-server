// The popup's icons: one outline set in the manner of SAP Fiori's Horizon icons (1.5 px strokes on a
// 16-unit grid), drawn for this extension, plus its own product mark and empty-state illustration.
// No SAP artwork and no icon font. Colours come from popup.css (currentColor, or the classes below).

const svg = (body, view = "0 0 16 16") => `<svg viewBox="${view}" aria-hidden="true" focusable="false">${body}</svg>`;
const o = (d) => `<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`;
const dot = (cx, cy, r = 0.9) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;

export const ICONS = {
  add: svg(o("M8 2.5v11M2.5 8h11")),
  overflow: svg(dot(3, 8, 1.4) + dot(8, 8, 1.4) + dot(13, 8, 1.4)),
  edit: svg(o("M10.5 2.5l3 3-8 8H2.5v-3z M9 4l3 3")),
  delete: svg(o("M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5")),
  key: svg(o("M7.6 8.4a3.4 3.4 0 1 1-1-2.4M7.6 8.4l6-6M11.6 4.4l1.6 1.6M10 6l1.2 1.2") + dot(4.6, 9.4, 0.9)),
  show: svg(o("M1.5 8C2.7 5.4 5.1 3.8 8 3.8s5.3 1.6 6.5 4.2c-1.2 2.6-3.6 4.2-6.5 4.2S2.7 10.6 1.5 8z") + o("M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z")),
  hide: svg(o("M1.5 8C2.7 5.4 5.1 3.8 8 3.8s5.3 1.6 6.5 4.2c-1.2 2.6-3.6 4.2-6.5 4.2S2.7 10.6 1.5 8z") + o("M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6zM2.5 2.5l11 11")),
  information: svg(o("M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5zM8 7.2v4.3") + dot(8, 4.9)),
  success: svg(o("M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5zM5.2 8.2l2 2 3.7-4")),
  warning: svg(o("M8 2l6.3 11.2H1.7zM8 6.3v3.4") + dot(8, 11.3)),
  error: svg(o("M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5zM5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4")),
  decline: svg(o("M3.5 3.5l9 9M12.5 3.5l-9 9")),
  pause: svg(o("M5.5 3v10M10.5 3v10")),
  play: svg(o("M4.5 2.8v10.4L13 8z")),
  settings: svg('<path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M13.11 6.25 L14.87 6.68 L14.87 9.32 L13.11 9.75 L12.85 10.38 L13.80 11.93 L11.93 13.80 L10.38 12.85 L9.75 13.11 L9.32 14.87 L6.68 14.87 L6.25 13.11 L5.62 12.85 L4.07 13.80 L2.20 11.93 L3.15 10.38 L2.89 9.75 L1.13 9.32 L1.13 6.68 L2.89 6.25 L3.15 5.62 L2.20 4.07 L4.07 2.20 L5.62 3.15 L6.25 2.89 L6.68 1.13 L9.32 1.13 L9.75 2.89 L10.38 3.15 L11.93 2.20 L13.80 4.07 L12.85 5.62Z M8 5.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2z"/>'),
  open: svg(o("M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4")),
  person: svg(o("M8 2.5a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2zM2.8 13.5c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4")),
  sso: svg(o("M8 1.8l5.2 2v4c0 3-2.2 5.3-5.2 6.4-3-1.1-5.2-3.4-5.2-6.4v-4zM5.6 8l1.7 1.7 3.2-3.4")),
  connected: svg(o("M6.5 9.5l3-3M7 4.5l1.3-1.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.3 1.3a2.5 2.5 0 0 1-3.5-3.5L5.5 8")),
  // The product's mark: a flat tile with a window and a prompt in it. Ours, not SAP's.
  mark: svg(
    '<rect class="mark-tile" width="32" height="32" rx="7"/>' +
      '<g class="mark-glyph" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="7" width="20" height="18" rx="3"/><path d="M11 13l4 3-4 3M17.5 19h4"/></g>',
    "0 0 32 32",
  ),
  // The empty state's picture: a system window waiting for its first entry.
  illustration: svg(
    '<circle class="il-ground" cx="60" cy="52" r="42"/>' +
      '<rect class="il-card" x="24" y="22" width="72" height="54" rx="8"/>' +
      '<path class="il-bar" d="M24 30a8 8 0 0 1 8-8h56a8 8 0 0 1 8 8v4H24z"/>' +
      '<rect class="il-line" x="34" y="44" width="34" height="5" rx="2.5"/><rect class="il-line soft" x="34" y="55" width="48" height="5" rx="2.5"/><rect class="il-line soft" x="34" y="66" width="24" height="5" rx="2.5"/>' +
      '<circle class="il-badge" cx="92" cy="74" r="13"/><path class="il-plus" d="M92 68v12M86 74h12"/>',
    "0 0 120 100",
  ),
};
