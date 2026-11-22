# Safety model

The server enforces these rules whatever the agent decides. They are a
safety net for an agent that makes mistakes, not a security boundary: see
[Security and data handling](../security.md) for what they do not protect
against.

The server works in your own sessions, as you, under your SAP
authorisations. It never logs on and never stores a password. Password
fields cannot be typed into, and nothing runs on a logon screen: log on
yourself.

## Settings

| Setting | Effect |
| --- | --- |
| `SAP_WRITE=off` (default) | actions that may write to SAP are refused: Save, Post, Delete, Release, Approve, "Yes" on a save popup |
| `SAP_WRITE=confirm` | your MCP client asks you before each such action; refused when it cannot ask (see [Confirm mode](confirm-mode.md)) |
| `SAP_WRITE=on` | such actions run |
| `SAP_ALLOW_SYSTEMS=ABA/800,S4H` | only these systems, optionally with a client, are visible and usable. Checked on every tool, each time: a session that moves to another system is refused from then on |
| `SAP_ALLOW_ORIGINS=https://myhost:44300` | only browser tabs of these origins are looked at |
| `SAP_ALLOW_TCODES=VA03,MM03` | the agent may open and work in only these transactions |
| `SAP_BLOCK_TCODES=SE38,SM30` | the agent may not open or work in these transactions |
| `SAP_ALLOW_LOGOFF=on` | the agent may end SAP sessions or the logon (`/nex`, `/nend`, `/i`, Log Off, Yes on the Log Off popup). Off by default, also with `SAP_WRITE=on`: logging off drops the unsaved work of every session, and only you can log on again |

Lists are separated by commas (or spaces) and are not case-sensitive. A
value of `SAP_WRITE` or `SAP_ALLOW_LOGOFF` the server does not know stops
it at start. Every setting: [Configuration](../reference/configuration.md).

## Systems

With `SAP_ALLOW_SYSTEMS` set, a session is visible only when its system
(and, when the entry names one, its client) is in the list: `ABA` allows
every client of ABA, `ABA/800` only client 800. Sessions of other systems
are hidden from `sap_sessions`, which says how many were hidden, and every
tool refuses them. A session whose system the server cannot read passes
only when no list is set.

For browser tabs, `SAP_ALLOW_ORIGINS` narrows what is looked at before any
of this: tabs of other origins are not read at all.

## Transactions

The transaction lists apply to commands (`/nSE38`, `/oSE38`, `/*SE38`, or
`SE38` alone) and to the transaction the session is in. A menu entry, a
favourite or a double-click in a tree can open a transaction without a
command: the server reads the transaction before and after each action. If
an action lands in a transaction the lists refuse, the server says so and
leaves it with `/n`. If the session is already in one, only a command that
leaves it is accepted. With `SAP_ALLOW_TCODES` set, a session may still sit
on the start screens (`SESSION_MANAGER`, `SMEN`, `S000`, the launchpad
home).

`/nex`, `/nend` and `/i` close sessions; they are not transactions, and
`SAP_ALLOW_LOGOFF` decides on them.

On Fiori the "transaction" is the app's intent (such as
`SalesOrder-display`), and the lists compare against that; a Web GUI app
inside the launchpad is not checked by its transaction code.

## The command field

The command field (`okcd`) takes commands through `{"do":"okcode"}` only.
`set`, `focus` or any other action on the field itself is refused, on every
surface, so that a command cannot go round the guard: typing `/11` or
`=SAVE` there and pressing Enter would pass none of the rules above.

## What counts as a write

Each surface classifies an action before it runs:

- **read:** value help, expanding a tree node, scrolling a list, listing a
  dropdown's entries;
- **navigate:** typing, Enter, tabs, Back, Execute (F8);
- **commit:** anything that may save, and anything not known to be safe.

Only commits are subject to `SAP_WRITE`.

The rule fails closed. A button, menu entry, function key or function code
is a commit unless it is known to be safe:

- by its key: Enter, Back, Cancel, F4, paging... (a toolbar button `btn[N]`
  is function key N);
- by its function code, such as the standard functions of ALV grids (sort,
  filter, find, details) and choosing or changing a classic list's layout
  (saving or deleting a layout stays a commit);
- by its menu, on Web GUI: entries under a list's Settings > Layout, and
  further selection criteria or dynamic selections;
- by its text, when the logon language is one the word lists cover;
- by its place, on Web GUI: the Goto menu, value help, a message popup, a
  report's selection screen, a screen that only displays (below).

A text that holds a commit word is a commit even when the rest of it is
safe ("Save and back"). A popup that asks whether to save, post or
delete makes every answer but No and Cancel a commit; the Enter button of
a popup that only informs just acknowledges it. Enter or Space on a focused
button counts as pressing that button. Typing works only in fields, never
on buttons.

Ending sessions or the logon (`/nex`, `/nend`, `/i`, Log Off, Yes on the
Log Off popup) is judged on its own, because it closes sessions and drops
unsaved data: it is refused unless `SAP_ALLOW_LOGOFF=on`, whatever
`SAP_WRITE` says, and runs when it is on. To leave a transaction, the agent
uses `/n`.

### Safe and commit words

Commit words (save, post, delete, release, approve...) are known in
English, German, French, Spanish, Portuguese, Italian and Dutch. Safe words
(Display, Find, Refresh, Next, Back...) are known in English, German,
French and Spanish. In another logon language, only ids, keys and function
codes count as safe, so more actions are held. The lists are in
[`src/core/words.ts`](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/src/core/words.ts),
one table for all surfaces.

### The cost of failing closed

With `SAP_WRITE=off`, some harmless buttons are refused too (for example
"Continue" on a popup whose text the server does not know as safe). The
agent is told why, and can tell you.

### A screen that only displays (Web GUI)

When the title of the main window says "Display ..." and the system toolbar
has no Save, the transaction's own buttons and menu entries count as
navigate (item conditions, schedule lines, a list of orders). SAP offers no
way to save there. Still held: anything named with a commit word, functions
that act beyond the screen (print, issue output, start, execute...), the
System and Help menus, and the toolbar buttons of grids and trees.

### Execute (F8)

Execute counts as navigate on purpose. It runs reports and lists (VA05,
ME2N...), which read. In Web GUI, Execute on a selection screen is a commit
when the screen shows that the report updates: a "Test Run" box that is not
ticked (tick it, and the report runs without writing), an "Update Run"
choice that is selected, or a title that names what the report does and not
a list ("Deletion of Jobs", "Batch Input: Process All Sessions"). A report
that updates without any of these signs still runs: put known update
programs in `SAP_BLOCK_TCODES`.

### Fiori

On Fiori the same rule reads a control's id (Fiori elements gives its
standard actions stable ids, such as Save, Create, Delete, Edit, Cancel),
its text, its press handlers and where it sits. An OData action behind a
button is a commit. In a draft-enabled app, typing into a field saves the
draft on the server at once: that is not counted as a commit; activating
the draft (Save, Create) is. Opening an app is navigation; an intent that
carries a function code for a transaction (`DYNP_OKCODE`) counts as a
write.

## A write goes only to the screen the agent saw

Before an action that may write runs, the server compares SAP's screen with
the last one it showed the agent: transaction, program, screen number and
popups. When SAP has moved on (a late answer, a popup, another program
acting on the session), the write does not run, and the answer is the
screen SAP is on now:

```
Not run: it may write, and SAP is not on the screen you last saw: it is now ZA01, program SAPMZA01, screen 100. Read the screen below; send the action again only if it is still what you want here
```

Sent again after that, it runs, because the agent has now seen that
screen. The same rule holds for the first write of a batch; the later
writes of a batch follow the batch's own rule ([Several actions in one
call](../reference/tools.md#several-actions-in-one-call)). Before any
screen was shown there is nothing to compare, and the write runs.

## After a write that did not run

A refused or declined write leaves the transaction as the agent left it,
often with a document open for change, and SAP keeps that document locked
for everyone else. So the answer tells the agent to leave without saving,
if it typed anything or opened a document to change it:
`{"do":"okcode","value":"/n"}`, or Back (F3) and the answer to SAP's "data
will be lost" question that leaves without saving. It is not to leave the
transaction open for you to save by hand, unless you ask for that. The
bundled agent skills say the same.

## What it does not catch

This is a safety net, not a guarantee. A custom button whose name is on the
safe list can still write, and so can a report started with F8 that shows
no sign of updating. Use a test system and a user with the authorisations
you want the agent to have.
