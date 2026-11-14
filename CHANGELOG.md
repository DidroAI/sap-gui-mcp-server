# Changelog

## 0.1.0 (unreleased)

- First version: SAP GUI for Windows (scripting), SAP GUI for HTML (Web GUI)
  and SAP Fiori, found automatically among the sessions you have open.
- Tools: `sap_sessions`, `sap_use`, `sap_look`, `sap_act`, `sap_confirm`,
  `sap_screenshot`.
- Guardrails: writes off by default (`SAP_WRITE`), system and transaction
  lists.
- Answers hold only what changed when an action leaves the session on the
  same screen (`SAP_VIEW=full` for the whole screen each time).
- Long lists: `scroll` for grids, table controls, trees and classic lists
  on SAP GUI and Web GUI; `sap_look` with `id` and `rows` reads a range; a
  `grid` action scrolls to a row that is not drawn.
- Web GUI reads classic lists (report output, the SE16 list, list popups).
- Shorter compact view: short unique handles for every id (shells and
  toolbar buttons too), dropdown entries on request, empty grid columns
  named once, repeated buttons of a selection screen on one line.
- An id that names several controls, or none, is refused with what the
  screen holds; the server no longer picks the nearest match.
- Web GUI waits: a lost connection and a step that is still running are
  reported; a tab in the background is driven at its own pace.
