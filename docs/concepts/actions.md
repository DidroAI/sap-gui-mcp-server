# Actions

The agent changes the screen with `sap_act`, one action per call. An action
is a small JSON object: what to do (`do`), on which control (`id`, from the
view), and what with (`value`, `key`, `row`, `col`...). The same actions
work on every surface; each surface says so when it does not support one.

```json
{"do": "set", "id": "ctxtVBAK-AUART", "value": "OR"}
{"do": "key", "key": 0}
{"do": "press", "id": "btn[8]"}
{"do": "okcode", "value": "/nVA03"}
{"do": "grid", "id": "cntlGRID1/shell", "row": 120, "col": "VBELN", "how": "double"}
```

Every action, its arguments and examples: [Actions reference](../reference/actions.md).

## The verbs

| Verb | Does |
| --- | --- |
| `set` | types into a field, a grid cell or a text editor |
| `press`, `click` | presses a button |
| `key` | sends a function key or a key: 0 Enter, 3 Back, 4 F4, 8 F8, 11 Save, 12 Cancel, or a name such as `Enter`, `Escape`, `Shift+Tab`, `Control+S` |
| `select` | a tab, a radio button, a menu entry, a list item; with `row`, a row of a table control or grid |
| `check` | ticks or clears a checkbox |
| `combo` | chooses a dropdown entry; without `key`, lists the entries |
| `okcode` | runs a command in the command field (`/nVA03`) |
| `f4` | opens value help |
| `focus` | puts the cursor on a field |
| `dblclick` | double-clicks a list entry or a label |
| `tree`, `grid`, `toolbar` | act on a tree node, a grid cell or row, a control's own toolbar |
| `scroll` | moves a long list |
| `open` | Fiori: opens a launchpad app by its intent |

## One shape for every action

The server brings every action to one shape before anything reads it: `do`
must be one of the verbs above (`fill` and `double`, older names, become
`set` and `dblclick`), a key must be a number from 0 to 99 or a known name,
and line breaks are removed from ids and values. Only the `value` of a
`set` keeps line breaks, for a text editor; a one-line field gets a space
in their place, never the Enter key, so a value cannot carry a command.
Actions that act on one control need an `id`. The guard and the surface
then work from that same object.

## What happens to one action

1. **Normalise** the action, as above. Anything malformed is refused with
   what was expected.
2. **Command field.** An action other than `okcode` on the command field is
   refused: commands go through `okcode`, which the guard reads.
3. **Where the session is.** With `SAP_ALLOW_SYSTEMS`, `SAP_ALLOW_TCODES`
   or `SAP_BLOCK_TCODES` set, a session outside them is refused; in a
   refused transaction only a command that leaves it is accepted.
4. **Assess.** The surface classifies the action as read, navigate or
   commit, from the screen as it is now.
5. **Decide.** The guard refuses it, holds it for your yes, or lets it run,
   from `SAP_WRITE` and the other settings ([Safety model](safety.md)).
6. **Act**, and wait for SAP to answer.
7. **Check where it led.** A menu entry, a favourite or a double-click in a
   tree can open a transaction without a command: the server reads the
   transaction after each action, and leaves one the lists refuse with
   `/n`.
8. **Answer** with the new screen, or with only what changed when the
   screen is the same one ([The screen view](screen-view.md)).

An action that fails (an id that is not on the screen, say) answers with
the reason and, when the screen is not the one the agent saw last, with the
screen it is on.

Calls on one session run one at a time: a second call waits for the first
to end, and its answer says how long it waited.

## Waiting for SAP

An action ends when SAP has answered it, not after a fixed time. Without
`timeout` an action waits 180 seconds for SAP (60 seconds with the `diag`
method), then says that SAP is still working. A slow action can be given
more time with `"timeout"` in seconds, up to 600:

```json
{"do": "key", "key": 8, "timeout": 300}
```

`timeout` applies on SAP GUI for Windows (both methods) and Web GUI.

## How SAP screens behave

A few rules an agent needs, from the
[`sap-gui-drive` skill](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/skills/sap-gui-drive/SKILL.md):

- **Fields take effect on Enter.** `set` only types; SAP checks the input
  and fills dependent fields after `{"do":"key","key":0}`. Fill all fields
  of a screen, then press Enter once.
- **Don't guess codes.** For a field that wants a code (order type, plant,
  company code), open its value help with `f4` and pick from the list.
- **Transactions:** `/nVA03` leaves the current transaction (unsaved input
  is lost) and starts another; `/oVA03` opens it in a new session (SAP
  GUI), which becomes the active one.
- **Popups** are their own windows (`wnd[1]`, `wnd[2]`). Answer them first:
  the screen below does not react while a popup is open. Enter on a
  question popup (Yes, No, Cancel in its body) is refused with the answers
  listed: press the one you mean by its id.
- **Escape** with a menu or a list open closes that only.
- **Back without saving:** F3 (`key 3`) goes back, F12 (`key 12`) cancels.
  If SAP asks whether to save, answer No unless the user asked to save.
