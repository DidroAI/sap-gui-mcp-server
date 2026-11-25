// The side panel's icons: one line set on a 24-unit grid, one stroke weight (1.75), round caps and
// joins, drawn for this extension, plus its own mark. No SAP artwork and no icon font.
// Colours come from panel.css (currentColor, or the mark's classes).

const svg = (body, view = "0 0 24 24") => `<svg viewBox="${view}" aria-hidden="true" focusable="false">${body}</svg>`;
const o = (d, w = 1.75) => `<path fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`;
const ring = (cx, cy, r) => `<circle fill="none" stroke="currentColor" stroke-width="1.75" cx="${cx}" cy="${cy}" r="${r}"/>`;
const dot = (cx, cy, r = 1.5) => `<circle fill="currentColor" cx="${cx}" cy="${cy}" r="${r}"/>`;

export const ICONS = {
  add: svg(o("M12 5.5v13M5.5 12h13")),
  more: svg(dot(5.5, 12) + dot(12, 12) + dot(18.5, 12)),
  back: svg(o("M14.5 6l-6 6 6 6")),
  chevron: svg(o("M9.5 6l6 6-6 6", 2)),
  settings: svg(o("M4 7.500h8.500M18.500 7.500H20M4 16.500h1.500M11.500 16.500H20") + ring(15.500, 7.500, 3) + ring(8.500, 16.500, 3)),
  edit: svg(o("M14.5 5.5l4 4L9 19H5v-4zM12.5 7.5l4 4")),
  delete: svg(o("M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5h9.2L17.5 7M10 11v5M14 11v5")),
  key: svg(ring(8, 15, 4) + o("M11 12l8.5-8.5M16 7l2.5 2.5M13.5 9.5l2 2")),
  show: svg(o("M2.5 12C4.5 8 8 5.5 12 5.5S19.5 8 21.5 12c-2 4-5.500 6.500-9.500 6.500S4.5 16 2.5 12z") + ring(12, 12, 3)),
  hide: svg(o("M2.5 12C4.5 8 8 5.5 12 5.5S19.5 8 21.5 12c-2 4-5.500 6.500-9.500 6.500S4.5 16 2.5 12z") + ring(12, 12, 3) + o("M4.5 4.5l15 15")),
  check: svg(o("M5.5 12.5l4.5 4.5 8.5-10", 2.25)),
  info: svg(ring(12, 12, 9) + o("M12 11v5.5") + dot(12, 7.75, 1.1)),
  warning: svg(o("M12 4L21 19.500H3zM12 10v4.500") + dot(12, 17, 1.1)),
  error: svg(ring(12, 12, 9) + o("M9 9l6 6M15 9l-6 6")),
  close: svg(o("M6.5 6.5l11 11M17.5 6.5l-11 11")),
  list: svg(o("M4.5 6.5h15M4.5 12h10M4.5 17.5h6")),
  monitor: svg(o("M4 5h16v11.500H4zM8.5 20h7")),
  shield: svg(o("M12 3.5l7 2.750V12c0 4.250-3 7-7 8.500C8 19 5 16.250 5 12V6.250z") + o("M9 12l2 2 4-4")),
  lock: svg(o("M6 11h12v9.500H6zM8.5 11V8a3.500 3.500 0 0 1 7 0v3")),
  open: svg(o("M14 4.5h5.500V10M19.500 4.500L11 13M17.500 14v5.500h-13v-13H10")),
  sso: svg(o("M12 3.5l7 2.750V12c0 4.250-3 7-7 8.500C8 19 5 16.250 5 12V6.250z")),
  person: svg(ring(12, 8, 3.75) + o("M4.5 20c1-3.500 3.750-5.500 7.500-5.500s6.500 2 7.500 5.500")),
  spinner: svg('<path fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" d="M20.5 12a8.5 8.5 0 1 1-5.800-8.060"/>'),
  // The product's mark: a soft pointer lit from inside, on a navy tile with a blue glow beneath it.
  // Ours, not SAP's: no SAP artwork, not SAP's blue. Colours come from panel.css (the mark-* tokens).
  mark: svg(
    '<defs>' +
      '<linearGradient id="mk-tile" x1="0" y1="0" x2="0" y2="1"><stop class="mk-t0" offset="0"/><stop class="mk-t1" offset="1"/></linearGradient>' +
      '<radialGradient id="mk-glow" cx="50%" cy="55%" r="50%"><stop class="mk-g0" offset="0"/><stop class="mk-g1" offset="1"/></radialGradient>' +
      '<radialGradient id="mk-ptr" cx="38%" cy="30%" r="75%"><stop class="mk-p0" offset="0"/><stop class="mk-p1" offset=".35"/><stop class="mk-p2" offset=".7"/><stop class="mk-p3" offset="1"/></radialGradient>' +
      '</defs>' +
      '<rect x="2" y="2" width="124" height="124" rx="30" fill="url(#mk-tile)"/>' +
      '<rect class="mark-edge" x="2.5" y="2.5" width="123" height="123" rx="29.5"/>' +
      '<circle cx="66" cy="70" r="52" fill="url(#mk-glow)"/>' +
      '<path d="M38 36L94 58L68 68L58 94Z" fill="url(#mk-ptr)" stroke="url(#mk-ptr)" stroke-width="14" stroke-linejoin="round"/>',
    "0 0 128 128",
  ),
};
