# MCP tools

The server registers eight tools under the server name `sap-gui`. Six work
on the open SAP sessions; two turn a session into a repeatable test.

| Tool | Does | Read-only hint |
| --- | --- | --- |
| [`sap_sessions`](#sap-sessions) | lists the SAP sessions open on this machine | yes |
| [`sap_use`](#sap-use) | makes a session the active one | yes |
| [`sap_look`](#sap-look) | the screen as text | yes |
| [`sap_act`](#sap-act) | one action, then the new screen | no (destructive hint) |
| [`sap_confirm`](#sap-confirm) | runs an action held for the user's yes | no (destructive hint) |
| [`sap_screenshot`](#sap-screenshot) | a PNG of the window or tab | yes |
| [`sap_record`](#sap-record) | records the run as a test | no |
| [`sap_replay`](#sap-replay) | runs a recorded test again, with no model | no (destructive hint) |

Source: [`src/server.ts`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/src/server.ts)
and [`src/record/tools.ts`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/src/record/tools.ts).
The parameter tables below follow the tools' input schemas.

## Common rules

- **`session`** (optional on most tools): which session to work in. A number
  from `sap_sessions`, a session id, a system id, a transaction, or a
  surface name (`sapgui`, `webgui`, `fiori`). Default: the active session.
- **One call at a time per session.** A second call on the same session
  waits until the first has ended. When it waited, the first line of its
  answer says how long.
- **Errors** come back as a tool result with `isError: true` and a text
  that says what was wrong and what to do instead.
- **Every tool checks the session against `SAP_ALLOW_SYSTEMS`** each time it
  is called ([Configuration](configuration.md)).

## sap_sessions

Lists the SAP sessions open on this machine: SAP GUI windows, Web GUI and
Fiori tabs in Chrome.

Parameters: none.

Returns: one line per session.

```
1. * webgui ABA (800) DEVELOPER   VA03     "Display Sales Order: Initial Screen"  [Chrome tab "..."]  origin=https://myhost:44300  id=chrome:...
```

- the number to pass as `session`;
- `*` marks the active session;
- surface, system and client, user, transaction, window title;
- where it is (`[SAP GUI ABA (800), session 1]` or the tab), the origin for
  a browser tab, and the session id.

It also says when no session was found, how many sessions of systems
outside `SAP_ALLOW_SYSTEMS` are hidden, and the reason a surface could not
be searched (for example, SAP GUI scripting is off).

## sap_use

Makes a session the active one for `sap_look`, `sap_act` and the others.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `session` | string | yes | number, id, system or transaction from `sap_sessions`, or a surface name: `sapgui`, `webgui`, `fiori` |

Returns: the whole screen of that session, in the compact view.

## sap_look

The current screen as text: a header (transaction or app, program, screen
number, system when known), then one line per control with its id, type,
label, value and state. Tables come as rows; popups as their own windows.
See [The screen view](../concepts/screen-view.md).

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `session` | string | no | the session; default the active one |
| `full` | boolean | no | the full view: every id, every column, each toolbar button and its key on a line of its own. Larger |
| `diff` | boolean | no | only what changed since the view you got last |
| `id` | string | no | one control, whole: all entries of a dropdown, all rows read of a grid, table, tree or list. `"mbar"` lists every menu entry |
| `rows` | string | no | with `id`: a range of rows counted from 0, such as `"120-180"` (also `"120"`, `"120 to 180"`, `"120..180"`). The control is scrolled there. At most 200 rows per call |
| `cols` | string | no | with `id`, for a grid or a table control: only these columns, by id or title, comma-separated (`"VBELN,NETWR"`). Without `rows`: rows 0 to 49 |

Returns: text.

- Without `id`, the whole screen (or with `diff`, the changes). The server
  remembers this view: later `sap_act` answers count changes from it.
- With `id`, only that control. What the server holds as "the screen you
  saw last" does not change.
- `rows` or `cols` without `id` is an error.
- On Fiori, `id` reads one control whole, including the part of a table
  below the fold; `rows` is not used there.

## sap_act

One action on the screen, by an id from `sap_look`. Answers with a line
that says what was done, then the new screen, or only what changed when
the screen is the same one.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `action` | object | yes | the action: `{"do": "...", ...}`. Every verb and field: [Actions reference](actions.md) |
| `session` | string | no | the session; default the active one |
| `full` | boolean | no | answer with the whole screen even when little changed |

Fields of `action` in the schema: `do` (string, required), `id`, `value`,
`key`, `node`, `how`, `row` (integer), `col`, `button`, `app`, `to`
(integer or string). Other fields pass through: `timeout` (seconds) and
`timing` (boolean) are read by the server.

Returns: text, in this order:

1. what was done (`set wnd[0]/usr/ctxtVBAK-VKORG`);
2. with `"timing": true` or `SAP_TIMINGS=on`, where the time went;
3. when the status bar holds an error, a warning or an abort: a line
   `STATUS E: ...` with what to do about it;
4. the screen, whole or as changes.

The change marks:

| Mark | Line |
| --- | --- |
| `~` | a line whose content changed, as it is now |
| `+` | a new line |
| `-` | a line that is gone |
| `=` | an unchanged line, for context |

The whole screen is sent on a new transaction, screen or popup, when the
changes are not much shorter than the screen, with `full: true`, and always
with `SAP_VIEW=full`.

Other answers:

- **Refused:** `Refused: <reason>` (`isError`). The guard, the command-field
  rule or the transaction lists said no.
- **Held** (with `SAP_WRITE=confirm`): when the client supports MCP
  elicitation, the client asks the user and the answer is the result (or
  `Not run: the user declined ...`). Otherwise the answer is
  `Needs the user's confirmation: ...` with a token for `sap_confirm`.
- **Failed:** the reason, and the screen the session is on when it is not
  the one the agent saw last.
- **`/o<transaction>` on SAP GUI:** the new session becomes the active one,
  and the answer says so.
- **Landed in a refused transaction** (through a menu, a favourite or a
  tree): the server leaves it with `/n` and says so (`isError`).

## sap_confirm

Runs an action that `sap_act` held for confirmation, with the token
`sap_act` gave. Used only when the client cannot ask the user itself.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `token` | string | yes | the token from `sap_act` |

Returns: the same as `sap_act` when the action runs.

- A token works once, whatever the outcome, and for ten minutes. At most
  50 tokens are held; the oldest go first.
- Before running, the server reads the screen again. If the session,
  surface, system, client, transaction, window title, action or the
  server's assessment of it changed, the answer is `Not run: the screen
  changed since the confirmation was asked (...)`.
- The server cannot check that the user said yes. See
  [Confirm mode](../concepts/confirm-mode.md).

## sap_screenshot

A PNG of the session's window or tab, for charts, HTML panels and visual
checks.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `session` | string | no | the session; default the active one |

Returns: one image content item (`image/png`, base64). On SAP GUI for
Windows the window must not be minimized.

## sap_record

Records what `sap_act` does as a repeatable test, and marks what the test
must check. Off until `start`. Guide: [Recording and replay](../guides/record-replay.md).

| Parameter | Type | Used by | Meaning |
| --- | --- | --- | --- |
| `op` | `start`, `stop`, `status`, `assert`, `capture`, `variable`, `note`, `undo`, `list`, `export` | all (required) | the operation |
| `name` | string | `start`, `export`, `variable`, `capture` | the recording's name (`start`, `export`), or the variable's name |
| `description` | string | `start`, `variable` | a description of the test or the variable |
| `replace` | boolean | `start` | record over a recording of the same name |
| `check` | `status`, `field`, `title`, `transaction`, `text` | `assert` | what to check |
| `id` | string | `assert`, `capture` on a field | the control id from `sap_look` |
| `equals`, `contains` | string | `assert` | the expected value |
| `matches` | string | `assert` | a regular expression |
| `value` | string | `variable` | the value it has in this recording |
| `from` | `status`, `field`, `title` | `capture` | where the value is read |
| `pattern` | string | `capture` | a regular expression whose first group is the value |
| `text` | string | `note` | what the last step is for |
| `to` | `calm`, `vbs`, `playwright`, `playwright-sap`, `gherkin` | `export` | the format |
| `session` | string | `start`, `assert`, `capture` | the session; default the active one |

What each operation answers:

| Operation | Answer |
| --- | --- |
| `start` | that recording started; it needs `name` |
| `assert` | the check as stored. Tried on the screen as it is now and refused if it does not hold. A field check without `equals`, `contains` or `matches` takes the field's value now |
| `capture` | the value read; refused if `pattern` finds nothing. Needs `name` and `from` |
| `variable` | the variable and how many recorded steps now use it. Needs `name` and `value` |
| `note`, `undo` | the step it applied to. `undo` drops the last step from the file; SAP is not undone |
| `status` | the steps so far |
| `stop` | where the file was written, with hints (typed values still fixed, a document number reused without a capture, no check at all) |
| `list` | the recordings in the recordings directory |
| `export` | the path written, then the file's text (cut after 6,000 characters). Without `name`, the recording last stopped |

Recordings are named, never addressed by path: they are read and written in
`SAP_RECORD_DIR` only. Recorded values are written to the file as typed.

## sap_replay

Runs a recording again on the session, step by step, with no model: the
same actions on the same ids, under the same write setting and transaction
lists as `sap_act`.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | no | the recording; default the one just stopped |
| `variables` | object of strings | no | values for the test's variables, such as `{"order": "4711"}` |
| `screens` | `strict`, `loose` | no | `loose`: landing on another screen than recorded is a note, not a failure |
| `choices` | `stop`, `continue` | no | a screen with a choice the recording does not have (availability control). `stop` (default): the step fails and names the ways on. `continue`: press its neutral Continue and say so |
| `from` | integer, 1 or more | no | resume at this step, on the screen as it is, with the variables the failed run ended with |
| `repair` | object | no | with `from`: a repair for that one step (below) |
| `format` | `text`, `json` | no | `json`: the result as data |
| `session` | string | no | the session; default the active one |

`repair` takes one of two shapes:

```json
{"why": "SAP asks for the company code first",
 "actions": [{"do": "set", "id": "ctxtBKPF-BUKRS", "value": "1000"}, {"do": "key", "key": 0}],
 "place": "after"}
```

```json
{"why": "a new order number each run",
 "capture": {"var": "order", "from": "status", "pattern": "Order (\\d+)"}}
```

- `actions`: at most 4, as `sap_act` takes them. `place`: `before` (then the
  recorded action runs), `instead` (they replace it), `after` (it already
  ran; they complete it).
- `earlier`: with `after` or a capture, actions an earlier try at this step
  already ran. They are not run again.
- `capture`: `var`, `from` (`status`, `field`, `title`), `id` for a field,
  `pattern`.
- Refused: a write the recorded step does not have, leaving the
  transaction, a typed value that is neither in the recording nor on the
  screen.

Returns: pass or fail per step. The first line says `PASS`, `PASS ... WITH
NOTES` (the replay confirmed an informing popup the recording did not have,
or used a fallback id) or `PASS ... REPAIRED at step N`. On a failure: the
phase (`act`, `landing`, `check`, `refused`), the reason and the screen
there; the session stays on it. A failed replay is returned with
`isError: true`. With `format: "json"`: the steps, the phase of a failure,
the full screen and the proposed test.

Refused while a recording is on: stop it first. A step that may write needs
`SAP_WRITE=on`.
