// The side panel's icons: one line set on a 24-unit grid, square caps and joins (the Didro platform's
// square rule), drawn for this extension, plus its own mark. No SAP artwork and no icon font.
// Colours come from panel.css (currentColor, or the mark's classes).

const svg = (body, view = "0 0 24 24") => `<svg viewBox="${view}" aria-hidden="true" focusable="false">${body}</svg>`;
const o = (d, w = 1.8) => `<path fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="square" stroke-linejoin="miter" d="${d}"/>`;
const dot = (cx, cy, r = 1.4) => `<circle fill="currentColor" cx="${cx}" cy="${cy}" r="${r}"/>`;

export const ICONS = {
  add: svg(o("M12 5v14M5 12h14")),
  more: svg(dot(5, 12) + dot(12, 12) + dot(19, 12)),
  back: svg(o("M15 18l-6-6 6-6", 2)),
  chevron: svg(o("M9 6l6 6-6 6", 2)),
  settings: svg(o("M4 7h9M17 7h3M4 17h3M11 17h9") + o("M13 5h4v4h-4zM7 15h4v4H7z")),
  edit: svg(o("M15 5l4 4L9 19H5v-4zM13 7l4 4")),
  delete: svg(o("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6")),
  key: svg(o("M11 13a4 4 0 1 1-1.2-2.8M11 13l8-8M16 8l2 2M14 10l1.5 1.5")),
  show: svg(o("M2 12c2-4 5.5-6.5 10-6.5S20 8 22 12c-2 4-5.5 6.5-10 6.5S4 16 2 12z") + o("M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z")),
  hide: svg(o("M2 12c2-4 5.5-6.5 10-6.5S20 8 22 12c-2 4-5.5 6.5-10 6.5S4 16 2 12z") + o("M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 4l16 16")),
  check: svg(o("M5 12l5 5 9-10", 2.4)),
  info: svg(o("M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v6") + dot(12, 7.6, 1.2)),
  warning: svg(o("M12 3l10 18H2zM12 10v5") + dot(12, 18, 1.2)),
  error: svg(o("M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM9 9l6 6M15 9l-6 6")),
  close: svg(o("M6 6l12 12M18 6L6 18")),
  list: svg(o("M4 6h16M4 12h10M4 18h6")),
  monitor: svg(o("M3 4h18v13H3zM8 21h8")),
  shield: svg(o("M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z") + o("M9 12l2 2 4-4")),
  lock: svg(o("M5 11h14v10H5zM8 11V8a4 4 0 0 1 8 0v3")),
  open: svg(o("M14 4h6v6M20 4l-9 9M18 14v6H4V6h6")),
  sso: svg(o("M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z")),
  person: svg(o("M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21c1-4 4-6 8-6s7 2 8 6")),
  spinner: svg('<path fill="none" stroke="currentColor" stroke-width="3" d="M21 12a9 9 0 1 1-6.2-8.6"/>'),
  // The product's mark: an ink tile, a white SAP-like field with a crimson caret, the agent's pointer. Ours, not SAP's.
  mark: svg(
    '<rect class="mark-tile" width="128" height="128"/>' +
      '<rect class="mark-field" x="18" y="30" width="92" height="42" fill="none" stroke-width="10"/>' +
      '<rect class="mark-caret" x="32" y="42" width="10" height="18"/>' +
      '<path class="mark-pointer" d="M64 56v54l14-13h24z" stroke-width="8" paint-order="stroke"/>',
    "0 0 128 128",
  ),
};
