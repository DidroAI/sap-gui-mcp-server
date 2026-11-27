---
title: "MCP tools for SAP: sap_look, sap_act and more"
description: "Every tool of the sap-ui-automation MCP server, what it does and when it is listed."
---

# MCP tools

The server gives an agent seven tools by default, under the server name
`sap-ui-automation`. Five work on the open SAP sessions and two turn a
session into a repeatable test. Two more list and log on to the systems
registered in the Chrome extension (`SAP_BROWSER=extension`), and two
save and run test code when you turn them on (`SAP_CODE_TOOLS=on`,
[Configuration](configuration.md#recording-and-files)).

| Tool | Does | Listed |
| --- | --- | --- |
| [`sap_sessions`](#sap-sessions) | lists the SAP sessions open on this machine | always |
| [`sap_use`](#sap-use) | makes a session the active one | always |
| [`sap_look`](#sap-look) | the screen as text | always |
| [`sap_act`](#sap-act) | one action, or several (`actions`), then the new screen | always |
| [`sap_screenshot`](#sap-screenshot) | a PNG of the window or tab | always |
| `sap_systems` | lists the SAP systems registered in the Chrome extension (name, address, client, user, how it logs on) | `SAP_BROWSER=extension` |
| `sap_logon` | opens a registered system and logs on; the extension fills SAP's logon page, the server never sees the password; `newSession: true` opens another session in a new window | `SAP_BROWSER=extension` |
| [`sap_record`](#sap-record) | records the run as a test | always |
| [`sap_replay`](#sap-replay) | runs a recorded test again, with no model | always |
| [`sap_code_save`](#sap-code-save) | checks and saves a `*.sap.ts` test | `SAP_CODE_TOOLS=on` |
| [`sap_code_test`](#sap-code-test) | runs a saved `*.sap.ts` test | `SAP_CODE_TOOLS=on` |

Source: [`src/server.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/server.ts),
[`src/record/tools.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/tools.ts)
and [`src/record/code-tools.ts`](https://github.com/DidroAI/sap-ui-mcp/blob/main/src/record/code-tools.ts).
The parameter tables below follow the tools' input schemas.

## Annotations

The MCP annotations each tool declares. Clients use them to decide what to
ask the user before a call; the server's own guard does not read them.

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `sap_sessions` | true | | true | false |
| `sap_use` | true | | true | false |
| `sap_look` | true | | true | false |
| `sap_act` | false | see below | | false |
| `sap_screenshot` | true | | true | false |
| `sap_systems` | true | | true | false |
| `sap_logon` | false | false | false | false |
| `sap_record` | false | false | | false |
| `sap_replay` | false | see below | | false |
| `sap_code_save` | false | false | | false |
| `sap_code_test` | false | see below | | false |

An empty cell means the tool does not set that hint. `destructiveHint` on
`sap_act`, `sap_replay` and `sap_code_test` follows the settings: true with
`SAP_WRITE=on` or `SAP_ALLOW_LOGOFF=on`, where a write or a log off can run
without the server asking; false otherwise. Under `SAP_WRITE=confirm` (the
default) the server asks before each write itself, and under `off` it
refuses them. Clients that ask before each call of a destructive tool
(Codex, for one) then do not ask before every navigation. `sap_use` is
read-only for SAP: it changes only which session the other tools use by
default. `openWorldHint` is false because the tools work in one closed SAP
system, not the open web.

## Common rules

- **`session`** (optional on most tools): which session to work in. A number
  from `sap_sessions`, a session id, a system id, a transaction, or a
  surface name (`sapgui`, `webgui`, `fiori`). Omit it to use the active session. For targeted work use the exact id on each call. If that id is unavailable, list sessions again and verify the intended target before retrying.
- **One call at a time per session.** A second call on the same session
  waits until the first has ended. When it waited, the first line of its
  answer says how long.
- **Errors** come back as a tool result with `isError: true` and a text
  that says what was wrong and what to do instead.
- **Every tool checks the session against `SAP_ALLOW_SYSTEMS`** each time it
  is called ([Configuration](configuration.md)).
- **Structured output** is off by default. With `SAP_STRUCTURED=on`, see
  [Structured content](#structured-content).

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

Several sessions can work at the same time: give each task its own session
and pass its `session` on every call. Calls on different sessions run at
once; calls on the same session wait their turn, and keep to that session
even if another one becomes the active one meanwhile. To get more sessions:

- the okcode `/o<tcode>` opens a new session of the same logon (SAP GUI: a
  new window; Web GUI: a new browser window), and the server follows it;
- with the Chrome extension, `sap_logon` with `newSession: true` opens a
  system in a new window and logs on there, even when it is open already,
  for the same system or another one. SAP may ask about the user's other
  logons; the agent asks the user, as for any logon. Its answer says
  whether the session is `new` or `reused`, its id, and whether SAP shows
  the logon's system, client and user (`verified`).

A Web GUI tab where SAP shows no system yet (still loading, or a popup) is
marked "not verified" in the list: it is not one to work in yet. At SAP's
limit of sessions per logon (6 by default), `/o` says so; another logon
with `newSession` has sessions of its own.

## sap_use

Makes a session the active one for `sap_look`, `sap_act` and the others.
Every other tool also takes `session` for a single call.

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

One action on the screen, by an id from `sap_look`, or several actions in
one call. Answers with a line that says what was done, then the new screen,
or only what changed when the screen is the same one.

The action's fields go at the top level of the call:

```json
{"do": "set", "id": "ctxtVBAK-AUART", "value": "OR"}
```

| Parameter | Type | Meaning |
| --- | --- | --- |
| `do` | one of `set`, `press`, `click`, `key`, `select`, `check`, `combo`, `okcode`, `f4`, `focus`, `dblclick`, `tree`, `grid`, `toolbar`, `scroll`, `open` | the verb. Needed for one action; left out with `actions` |
| `id` | string | the control, from the view |
| `value` | string, number or boolean | `set`, `check`, `okcode`, `select` with `row` |
| `key` | number or string | `key`, `combo` |
| `row` | number | a row of a grid or table, counted from 0 |
| `col` | string | a grid column, a tree item |
| `how` | string | `grid`, `tree` |
| `node` | string | `tree` |
| `button` | string | `toolbar` |
| `to` | number or string | `scroll` |
| `app` | string | `open` (Fiori) |
| `timeout` | number | seconds the step may take, up to 600 (SAP GUI and Web GUI; default 180) |
| `actions` | list of actions, at most 20 | several actions in one call, in place of `do` and its fields ([below](#several-actions-in-one-call)) |
| `session` | string | the session; default the active one |
| `full` | boolean | answer with the whole screen, not the changes |

Every verb and field: [Actions reference](actions.md). No field is required
by the schema; the server checks the rest (a `do` it knows, a whole `row`,
a known `key`) and says what is missing. Sending `do` and `actions` in the
same call is refused.

With `"timing": true` (or `SAP_TIMINGS=on`) the answer adds a line that
says where the time went. `timing` is not in the schema: the input accepts
other keys and passes them on.

Returns: text, in this order:

1. what was done (`set wnd[0]/usr/ctxtVBAK-VKORG`), and the timing line
   when asked for;
2. when the status bar holds an error, a warning or an abort: a line
   `STATUS E: ...` with what to do about it;
3. the `code:` line, while a recording is on (see the tip below);
4. an empty line, then the screen, whole or as changes.

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
  rule or the transaction lists said no. With writing off, the reason says
  "Tell the user what you would have saved; do not look for another way",
  and explains the document lock. Leaving with `/n` discards unsaved
  edits. Preserve existing work unless the user authorizes discarding it.
- **Not run, the screen moved:** `Not run: it may write, and SAP is not on
  the screen you last saw: it is now ...`, then the screen. A write runs
  only on the screen the server last showed the agent; sent again, it runs
  ([Safety model](../concepts/safety.md#a-write-goes-only-to-the-screen-the-agent-saw)).
  This also holds for the first write of a batch.
- **Asked** (with `SAP_WRITE=confirm`, the default): the client asks the user through
  MCP elicitation, and the answer is the result once they accept, or
  `Not run: the user declined ...`, which tells the agent to stop and not
  retry. A client without elicitation gets `Refused: ... this client cannot
  ask the user ...` (`isError`), and the first answer of the session opens
  with a `NOTE:` line saying so ([Confirm mode](../concepts/confirm-mode.md)).
- **Failed:** the reason, a `Next: ...` line when a field is closed or a
  control does not scroll, then where the session is: one line when the
  screen is as the agent saw it last, otherwise the screen.
- **`/o<transaction>` on SAP GUI:** the new session becomes the active one,
  and the answer says so.
- **Landed in a refused transaction** (through a menu, a favourite or a
  tree): the server leaves it with `/n` and says so (`isError`).

::: tip The SDK line
While a recording is on, every `sap_act` answer of an
action that ran has a line such as `code: await sap.set("VBAK-VBELN", "4711");`:
the [SDK](../guides/sdk-tests.md) call that repeats the action. Without a
recording there is no such line. `SAP_CODE=on` adds it always,
`SAP_CODE=off` never, also while recording. `sap_record {"op":"code"}`
gives the whole script with or without the line.
:::

### Several actions in one call

`actions` runs up to 20 actions in order and answers once:

```json
{"actions": [
  {"do": "set", "id": "ctxtVBAK-AUART", "value": "OR"},
  {"do": "set", "id": "ctxtVBAK-VKORG", "value": "1000"},
  {"do": "key", "key": 0}]}
```

Each entry takes the fields of one action, plus:

| Field | Type | Meaning |
| --- | --- | --- |
| `expect` | object | what this step knows will happen, so the batch goes on through it: `screen` (the screen number, string or number), `transaction`, `title` (text the title contains), `status` (`S`, `I`, `W`, `E`, `A`, or text of the message), `popup` (true or false) |
| `show` | boolean | add the screen after this step to the answer |
| `unseen` | boolean | let a write run on a screen the batch reached after you sent it |

Before anything runs, the whole batch is read: an entry that is not a valid
action, an unknown key in `expect`, a command the transaction lists refuse,
or a `/o...` command (send it on its own) refuses the batch, and nothing
runs.

Then each action is judged by the guard when its turn comes, on the screen
as it is then, as if it were sent alone. The batch holds the session: no
other call runs in between. It ends before the next action when:

- an action fails or is refused;
- an action may write and the user is asked about it (it is asked alone);
- a popup opened;
- the status bar shows an error, a warning or a termination (a `set`,
  `check` or `focus` does not end it on a message that was there before);
- the screen is another one (transaction, program or screen number);
- a step's `expect` is not met;
- SAP is still working on the step.

`expect` lets the batch go on through what it names: `{"screen":"4001"}`,
`{"popup":true}`, `{"status":"W"}`. None of these end the batch after its
last action.

An `okcode` that opens a transaction (`/nVA03`, `/*VA03`) needs no
`expect`: the batch goes on into that transaction's first screen, as if
the step said `{"transaction":"VA03"}`. So a batch can start with the
transaction and fill its first screen in the same call. The actions after
it are still checked one by one: an id that is not on that screen fails
and ends the batch, and a write there needs `unseen`.

**A write never runs on a screen the agent has not seen in the batch.** An
action that may write, after the first, does not run when the screen or
the popups are not the ones the agent saw when it sent the batch (an
`expect` let it go on through a new screen). SAP raises no message for
wrong but valid data, such as another customer or a zero price, so the
stop rules cannot catch it. The answer says so and shows the screen; send
the write again from there, or mark the step `"unseen": true` when you know
that screen. A refusal from the write setting still comes first. The
first action of a batch, when it may write, must find SAP on the screen
the server last showed the agent, as a single write must; otherwise the
batch stops before it (`Ran 0 of N actions. Stopped: action 1 (...) did
not run: ...`) and shows the screen.

The answer:

```
Ran 2 of 3 actions. Stopped: after action 2, the status bar shows E: Fill in all required fields. Action 3 did not run.
1. <what action 1 did>
2. <what action 2 did>
STATUS E: Fill in all required fields  (error: correct the input it names, then Enter)

<the screen>
```

- The first line is `Ran N actions.` when all ran, or
  `Ran K of N actions. Stopped: <why>.` with the actions that did not run.
- `Action N: expected ...` when the last step's `expect` was not met.
- One `n. <note>` line per action that ran, and with `show`, the screen
  after that step between `---` lines.
- While recording: `code:` and one SDK line per action.
- Then the status line and the screen, once.

A batch is an error result when an action failed or was refused. Under
`SAP_WRITE=confirm`, the write that ends the batch is asked about on its
own; the answer is then that action's result, or `Not run: the user
declined ...`.
While a recording is on, each action of a batch is its own step.

When the client sends a `progressToken`, each action that ran is a
`notifications/progress` (`progress` of `total`). When the client cancels
the call, the action running ends and the ones after it do not run.

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
| `op` | `start`, `stop`, `status`, `assert`, `capture`, `variable`, `note`, `undo`, `code`, `list`, `export`, `help` | all (required) | the operation |
| `name` | string | `start`, `export`, `variable`, `capture`, `code` with `tidy` | the recording's name (`start`, `export`, `code`), or the variable's name |
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
| `to` | `calm`, `vbs`, `playwright`, `playwright-sap`, `sap-ts`, `gherkin` | `export` | the format |
| `tidy` | boolean | `code` | the recording tidied: detours, corrections and error round trips dropped, checks from what SAP showed |
| `session` | string | `start`, `assert`, `capture`; `code` from session history | the session; default the active one |

What each operation answers:

| Operation | Answer |
| --- | --- |
| `start` | that recording started; it needs `name`, and says so with an example |
| `assert` | the check as stored. Tried on the screen as it is now and refused if it does not hold. A field check without `equals`, `contains` or `matches` takes the field's value now |
| `capture` | the value read; refused if `pattern` finds nothing. Needs `name` and `from` |
| `variable` | the variable and how many recorded steps now use it. Needs `name` and `value` |
| `note`, `undo` | the step it applied to. `undo` drops the last step from the file; SAP is not undone |
| `status` | the steps so far |
| `code` | the recording so far as a `*.sap.ts` test. With no recording on, a draft of the actions this server ran on the session (the last 200) |
| `code` with `"tidy": true` | the recording that is on, or else the one `name` names (default: the one last stopped), tidied, then the removal log and a TODO list ([Tidy code from a recording](../guides/record-replay.md#tidy-code-from-a-recording)) |
| `stop` | where the file was written, with hints (typed values still fixed, a document number reused without a capture, no check at all) |
| `list` | the recordings in the recordings directory |
| `export` | the path written, then the file's text (cut after 6,000 characters). Without `name`, the recording last stopped |
| `help` | every op with an example of its fields |

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
| `from` | whole number, 1 or more | no | resume at this step, on the screen as it is, with the variables the failed run ended with |
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

The answer of a failed replay says this shape and how to go on; the tool's
description does not.

Returns: pass or fail per step. The first line says `PASS`, `PASS ... WITH
NOTES` (the replay confirmed an informing popup the recording did not have,
or used a fallback id) or `PASS ... REPAIRED at step N`. On a failure: the
phase (`act`, `landing`, `check`, `refused`), the reason and the screen
there; the session stays on it. The answer ends with how to go on (`from`,
`repair`) and a warning not to replay to retry a failed write. A failed
replay is returned with `isError: true`. With `format: "json"`: the steps,
the phase of a failure, the full screen and the proposed test.

Refused while a recording is on: stop it first. A step that may write needs
`SAP_WRITE=on`.

## sap_code_save

Listed only with `SAP_CODE_TOOLS=on`. Checks a test written with the
[SDK](../guides/sdk-tests.md), then writes it to `<name>.sap.ts` in
`SAP_RECORD_DIR`. For agents without a file system; the usual start is
`sap_record {"op":"code","tidy":true}`.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | the test's name, as the recording's. A name, never a path |
| `code` | string | yes | the whole `*.sap.ts` file |

Returns: `Saved <path>` with what was checked, or `Not saved: N
problem(s)` with each problem (`isError`). The checks: syntax, imports
(only `expect` and `test`), forbidden words, computed member access, and
commit parity (a call that may write only when the recording of the same
name has a write). The code is not type-checked. Details and the risk:
[Code tools](../guides/record-replay.md#code-tools-sap-code-save-and-sap-code-test).

## sap_code_test

Listed only with `SAP_CODE_TOOLS=on`. Runs a test saved with
`sap_code_save` on the session through the test runner.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | the test's name, as saved |
| `variables` | object of strings | no | values that override the test's `const vars` |
| `session` | string | no | the session; default the active one |

Returns: `PASS` or `FAILED` per test with its time; on a failure the error,
the line of the saved file, the `sap.step` it was in, the trace file and
the screen after the run (`isError`).

- The checks of `sap_code_save` run again on the file as it is.
- The test is verified against `<name>.sap.lock.json`, which its first
  pass writes. Where SAP answers otherwise, it fails with `Drift`: the
  step, the action and the screen. Fix the code with `sap_code_save` if
  SAP changed ([Lock files](../guides/sdk-tests.md#lock-files)).
- The test runs under the server's `SAP_WRITE`, `SAP_ALLOW_TCODES` and
  `SAP_BLOCK_TCODES`, on the server's session. A test cannot widen them.
- Refused while a recording is on.

## Reading answers from code

Answers are text. Code that reads them without `SAP_STRUCTURED=on` can rely
on this order for `sap_act`, top to bottom (each line only
when it applies). Under `SAP_WRITE=confirm` (the default) with a client without MCP
elicitation, the first `sap_look` or `sap_act` answer of the server starts
with one more line before these: `NOTE: writing is set to confirm, and this
client cannot ask the user ...`.

1. `(This call waited N s for the call before it on this session ...)`:
   another call on the same session ran first.
2. The action's note: `did set`, `pressed btn[8]`, ... For a batch, the
   header line instead: `Ran N actions.` or
   `Ran K of N actions. Stopped: <why>. Actions J to N did not run.`, then `Action N: expected ...` when
   the last step's `expect` was not met, then one `n. <note>` line per
   action that ran.
3. `STATUS E|W|A: <message>  (<what to do>)`: an error, warning or
   termination in the status bar, said before the screen.
4. `code: await sap....;` (one action), or `code:` followed by one line per
   action (a batch): only while recording, or with `SAP_CODE=on`.
5. An empty line, then the screen: the whole compact view (it starts with
   `TRANSACTION ...` or the Fiori app's header), or on the same screen
   `CHANGED n of m lines (same screen; sap_look shows all of it):` followed
   by `~`, `+`, `-` and `=` lines, or `NO CHANGE on the screen (...)`. A
   diff that left out an E, W or A status bar line ends with
   `= sbar  status  <type>: <message>`.

A refusal or a failure is an error result (`isError: true`) whose first
line is `Refused: ...` or the failure; after it, `Next: ...` for a closed
field, then where the session is (`The screen is as you last saw it: ...`)
or the screen. A failed batch puts the header line first, then the screen.

### Structured content

With `SAP_STRUCTURED=on`, the answers code reads also carry
`structuredContent`, and the tools declare output schemas. The text stays
the same. Off by default: clients differ on an answer with both, and the
default should not cost tokens.

| Tool | `structuredContent` |
| --- | --- |
| `sap_sessions` | `{sessions: [{n, active, id, surface, system, client, user, transaction, title, where}]}` |
| `sap_act` | `{ran, total, stopped?: {why, text}, screen: {transaction, program, number, title, popup}, status?: {type, text}}` |
| `sap_replay` | `{passed, steps: [{n, outcome, ms, failures}], variables}` |
| `sap_record` | `{recording, name?, steps?}`, after every op |

`stopped.why` is one of `status`, `popup`, `screen`, `expect`, `busy`,
`failed`, `refused`, `unseen`, `held`, `transaction`, `declined`. A single
action that fails or is refused carries no structured content; a batch
carries it on a failure too.
