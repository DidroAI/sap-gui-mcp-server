# Writing tests with the SDK

The npm package is also a TypeScript library (the SDK) and a test runner
for `*.sap.ts` tests. A script attaches to an SAP session you have open, acts on it with the same actions as `sap_act`, and checks the screen
with assertions that wait. It goes through the same guard as the MCP server:
`SAP_WRITE`, `SAP_ALLOW_SYSTEMS` and the transaction lists apply.

## Set up

The SDK and the test runner import the package, so install it in your
project (Node.js 22.18 or later runs the TypeScript files as they are):

```sh
npm install --save-dev sap-ui-automation
npx sap-ui-automation init         # sap.config.ts, sap-tests/example.sap.ts, skills, MCP clients
npx sap-ui-automation test --list  # what would run
npx sap-ui-automation test         # needs an SAP session open, logged on
```

Without the install, `test` stops with `Cannot find package
'sap-ui-automation'`.

## A script

```ts
import { connect, expect } from "sap-ui-automation";

const sap = await connect({ surface: "webgui", system: "ABA" });

await sap.okcode("/nVA03");
await sap.set("VBAK-VBELN", "4711");
await sap.key("Enter");

await expect(sap).toHaveTransaction("VA03");
await expect(sap.field("VBAK-NETWR")).toHaveValue("100.00");
await expect(sap.status()).not.toBeError();

await sap.close();
```

`connect()` never logs on: it attaches to a session that is open now.
`await using sap = await connect()` closes it at the end of the block.

### `connect(options)`

| Option | Default | Meaning |
| --- | --- | --- |
| `surface` | `SAP_SURFACES`, else every surface this machine can serve | `"sapgui"`, `"webgui"`, `"fiori"`, or a list |
| `system` | any | `"ABA"` or `"ABA/800"`: the first session of that system |
| `session` | the first that fits | any reference `sap_sessions` accepts: a list number, an id, a transaction, part of a title |
| `write` | `SAP_WRITE`, else `confirm` | `confirm` (refused without `onConfirm`; a test has none), `off` or `on` |
| `onConfirm` | none | called for each action that may write when `write` is `confirm`; without it, such an action is refused |
| `allowSystems`, `allowTcodes`, `blockTcodes` | the environment's | override `SAP_ALLOW_SYSTEMS`, `SAP_ALLOW_TCODES`, `SAP_BLOCK_TCODES` |
| `timeout` | `5000` | default timeout of `expect` and `waitFor`, in ms |
| `trace` | off | `{ dir, name, screenshots? }`: record the run as a trace (see [Trace viewer](trace-viewer.md)) |
| `verify` | off | `{ lock, key, mode }`: check each action against a lock file (see [Lock files](#lock-files)) |

An action the guard refuses throws `Refused`; the action did not run.

### Actions

Each method runs one action and resolves with the answer `sap_act` would
give. The ids are the ones `sap_look` shows ([Ids and handles](../concepts/ids.md)).

| Method | Action |
| --- | --- |
| `okcode(value)` | type into the command field and press Enter (`"/nVA03"`) |
| `set(id, value)` | set a field, a checkbox, or a grid cell (with `{ row, col }`) |
| `press(id)`, `click(id)` | press a button; click (Fiori) |
| `key(key)` | a key: a number (0 Enter, 3 Back, 8 F8, 11 Save) or a name (`"Enter"`) |
| `select(id)`, `check(id, value)`, `combo(id, key)` | tabs and rows, checkboxes, dropdowns |
| `f4(id)`, `dblclick(id)`, `focus(id)`, `scroll(id, to)` | value help, double-click, cursor, scrolling |
| `open(app)` | Fiori: open a launchpad app by intent (`"#SalesOrder-manage"`) |
| `act({...})` | any action of the [action reference](../reference/actions.md) |
| `look(options)` | the compact screen, as `sap_look` returns it |
| `screenshot()` | a PNG of the window or tab |
| `waitFor(fn, timeout)` | waits until `fn(screen)` holds |

### Steps, and screens SAP shows for some data only

These helpers make a script read like the test a person would write. The
[tidied code of a recording](record-replay.md#tidy-code-from-a-recording)
uses them.

| Method | Does |
| --- | --- |
| `step(name, fn)` | runs `fn` as one named step: its actions carry the name in the trace and in `sap.history`, and an error inside ends with `(in step "name")`. Steps nest. Returns what `fn` returns |
| `at(place)` | is the session on this screen now? `"SAPLATP4/0500"` (program and screen number), or `{ program, screen, transaction }`. Reads once, never waits |
| `popup()` | the popup in front: `{ title, text }`, or `undefined` |
| `button(label).press()` | presses a button by its label, the popup in front first: the exact label, then without the key SAP shows (`Continue (Enter)`), then in any case. A label that several buttons have is refused. Also `.exists()` |
| `save({ acceptWarnings, max })` | key 11, through the guard. With `acceptWarnings`, presses Enter while the status bar shows a warning, at most `max` times (default 3), then throws if a warning is still there. Returns the status bar |
| `dismissInfo()` | confirms the popup in front only when it informs (text and Continue, no question, no input), by the rule a replay uses. `true` when it confirmed one |

```ts
await sap.step("Save the order", async () => {
  if (await sap.at("SAPLATP4/0500")) await sap.button("Continue").press();
  await sap.save({ acceptWarnings: true });
  await sap.dismissInfo();
});
const order = await expect(sap.status()).capture(/Order (\d+)/);
```

### Locators and assertions

`expect` re-reads the screen until the assertion holds or its timeout runs
out, then fails with what it last saw. Every assertion takes `.not`, and an
optional `{ timeout }`.

| Subject | Assertions |
| --- | --- |
| `sap.field(id)` / `sap.control(id)` | `toHaveValue`, `toContainValue`, `toBeEmpty`, `toBeEditable`, `toBeReadOnly`, `toBeVisible`, `toBeChecked`, `toHaveLabel` |
| `sap.status()` | `toHaveText`, `toContainText`, `toBeSuccess`, `toBeError`, `toHaveType("S"\|"I"\|"W"\|"E"\|"A")`, `toBeEmpty`, `capture(re)` |
| `sap.grid(id)` | `toHaveRowCount`, `toContainText` (optionally in `rows`), `toBeVisible` |
| `sap` | `toHaveTransaction`, `toHaveTitle`, `toBeOnScreen({ program, screen })`, `toContainText` |
| any value | `toBe`, `toEqual`, `toContain`, `toMatch`, `toBeTruthy`, `toBeGreaterThan`, `toBeLessThan` |

Text arguments take a string (whole match for `toHaveValue`/`toHaveText`)
or a regular expression.

`expect(sap.status()).capture(re)` waits until the status bar matches `re`
and returns its first group (the whole match without a group): a number
SAP made, for the steps after it. It cannot be negated.

Grid locators also act: `selectRow(row)`, `double(row, col)`,
`setCell(row, col, value)`, `scroll(to)`.

::: warning Row counts of table controls
On a table control (the classic step loop, such as the items of VA03), SAP
draws empty lines to fill the visible area, and `rowCount()` and
`toHaveRowCount` count them: an order with one item gives 9 on VA03. On an
ALV grid the count is the real number of rows. For a table control, check
the rows you expect instead, with `cell(row, col)` or `toContainText`.
:::

### From an agent's run to a script

While a recording is on, every `sap_act` answer has a `code:` line: the
SDK call that repeats the action (`SAP_CODE=on` adds it always,
`SAP_CODE=off` never). `sap_record {"op":"code"}` gives the script so far,
with or without a recording. In a script, `sap.code()` returns the lines of
the run so far, and `sap.draft(name)` a test file around them. A recording
can also be written out as a script (`export --to sap-ts`), and
`sap_record {"op":"code","tidy":true}` writes the tidied test, with steps
and the helpers above (see [Recording and replay](record-replay.md#tidy-code-from-a-recording)).

### Replaying a verified recording

`runVerified(sap, file, { variables, fallback, save })` replays a recording
that is known to work, with no model. Only at a step where the screen is not
what the recording expects does it call `fallback` (a model, a person, any
function) for a repair; repairs run under the replay's rules and, with
`save`, are written into a new version of the recording.

`runVerified` also runs test code against its [lock file](#lock-files):

```ts
const r = await runVerified(sap, { file: "sap-tests/create.sap.ts", export: "createOrder" },
  { customer: "2200" },
  { fallback: async (drift) => askModel(drift) }); // only for drift no saved repair fixes
// r.passed, r.verified, r.unverified, r.fallbacks, r.repairs, r.patches, r.drift
```

On drift it pauses inside the run, before anything else happens in SAP,
and awaits `fallback`. A repair runs under the replay's rules (at most 4
actions, no write the action does not make, no leaving the transaction, no
value that is in neither the lock, the parameters nor the screen) and must
land where the lock says. A repair that worked is saved in the lock as an
overlay and applied with no model the next time the same drift shows. The
`.sap.ts` is never rewritten: `r.patches` proposes the change to the code
for a person to review.

## Lock files

Test code says what to do. A lock file, `<name>.sap.lock.json` next to
`<name>.sap.ts`, records what the screens looked like on runs that passed:
for each `sap.step` block, each action's control, the screen it ran on, and
the screen, popup and status it led to. Typed values are kept but not
compared. With a lock, a code run checks every action as a replay checks a
recording, with no model.

- The runner verifies against the lock by default (`use: { lock: "verify" }`).
  The first pass writes it; later passes rewrite it only when its paths,
  repairs or system change, so a stable lock does not show in diffs.
- Where SAP answers otherwise (another screen, a popup, a new error in the
  status bar), the test fails with a `Drift` error that names the step, the
  action, its line in the file, what the lock expected and what came. Every
  read and action after it throws the same error.
- When the code asks about the screen right after (`sap.at`, `sap.popup`,
  `exists()`, `dismissInfo`, `save({ acceptWarnings })`), a different
  landing is a branch, not drift: the code handles it, and a passing run
  adds that path to the lock. This is how screens SAP shows for some data
  only pass.
- A lock verified on another system or surface is not compared.
- Paths are only added. Delete the lock, or its entry, to start again.

| Mode | Does |
| --- | --- |
| `verify` (default) | compare; a passing run adds what the lock does not have |
| `write` | compare nothing, add this run's screens (`npx sap-ui-automation test --update-locks`) |
| `off` | leave the lock alone |

In a script, `connect({ verify: { lock: "x.sap.lock.json", key: "my test", mode: "verify" } })`
does the same. Commit lock files with the tests. `sap_code_test` also checks
against the saved test's lock and reports drift.

## The test runner

Test files end in `.sap.ts`:

```ts
import { test, expect } from "sap-ui-automation/test";

test("order 4711 is complete", async ({ sap }) => {
  await sap.okcode("/nVA03");
  await sap.set("VBAK-VBELN", "4711");
  await sap.key("Enter");
  await expect(sap.status()).not.toBeError();
});
```

`test.describe`, `test.skip`, `test.only`, `test.beforeEach` and
`test.afterEach` work as in Playwright. A `sap.config.ts` sets the defaults:

```ts
import { defineConfig } from "sap-ui-automation/test";

export default defineConfig({
  testDir: "sap-tests",
  timeout: 60_000,
  retries: 0,
  reporter: "list", // list | junit | json | html
  outputDir: "sap-results",
  use: { surface: "webgui", system: "ABA", write: "off", screenshots: true, lock: "verify" },
});
```

Run them:

```sh
npx sap-ui-automation test                     # every *.sap.ts under testDir
npx sap-ui-automation test sap-tests/va03.sap.ts --reporter junit
npx sap-ui-automation test --grep "order" --project s4
npx sap-ui-automation test --list                # what would run
```

Node 22.18 or later loads the TypeScript files as they are; from 22.6 the
runner re-runs itself with `--experimental-strip-types`, and below that it
says to use 22.18. Test files and configs load as ES modules even when the
project's `package.json` says `"type": "commonjs"`.

The runner finds `sap.config.ts` (or `.js`, `.mjs`, `.json`) by walking up
from the current folder. The `sap` fixture connects to SAP only for a test
or hook that takes it as a parameter. A test that passes on a retry is
reported as flaky; finding no tests exits with 1. The list, JUnit and
HTML reports name the step and action of a drift, and the lock. The `html` reporter
writes `sap-results/index.html`, which links each test's trace page.

Two things to know about the output in this version:

- `sap-results/` is not emptied before a run. Traces of tests that no
  longer exist, or of earlier retries, stay next to the new ones. Delete
  the folder first when you want only this run (`rm -rf sap-results`).
- `--reporter` on the command line replaces the config's reporters with
  their default files: `--reporter html` writes `sap-results/index.html`
  even when the config says `["html", { outputFile: "report.html" }]`. Set
  the reporters in the config when you need their `outputFile`.

Flags: `--config <file>`, `--project <p>`, `--reporter list,junit,json,html`,
`--grep <re>`, `--retries <n>`, `--list`, `--update-locks` (write the
[lock files](#lock-files) from this run). Test files match
`**/*.sap.{ts,js,mjs}` under `testDir` (default: the config's folder).

Tests run one at a time (one SAP session is one user's screen). Each test's
trace goes to `sap-results/<test>/`; open it with the
[trace viewer](trace-viewer.md). `npx sap-ui-automation init` writes a config and an
example test to start from ([CLI](../reference/cli.md)).

In CI, the machine running the tests needs an SAP session open (a Web GUI
tab in Chrome, or SAP GUI on a Windows runner). Keep `write` at `off` unless
the test system is meant to be changed.
