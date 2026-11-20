# Writing tests with the SDK

The package is also a library. A script attaches to an SAP session you have
open, acts on it with the same actions as `sap_act`, and checks the screen
with assertions that wait. It goes through the same guard as the MCP server:
`SAP_WRITE`, `SAP_ALLOW_SYSTEMS` and the transaction lists apply.

::: info Version
The SDK and the test runner are new; check `npx sap-gui --help` for the
flags of the version you have.
:::

## A script

```ts
import { connect, expect } from "sap-gui-mcp-server";

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
| `write` | `SAP_WRITE` (`off`) | `off`, `confirm` or `on` |
| `onConfirm` | none | called for each action that may write when `write` is `confirm`; without it, such an action is refused |
| `allowSystems`, `allowTcodes`, `blockTcodes` | the environment's | override `SAP_ALLOW_SYSTEMS`, `SAP_ALLOW_TCODES`, `SAP_BLOCK_TCODES` |
| `timeout` | `5000` | default timeout of `expect` and `waitFor`, in ms |
| `trace` | off | `{ dir, name, screenshots? }`: record the run as a trace (see [Trace viewer](trace-viewer.md)) |

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

## The test runner

Test files end in `.sap.ts`:

```ts
import { test, expect } from "sap-gui-mcp-server/test";

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
import { defineConfig } from "sap-gui-mcp-server/test";

export default defineConfig({
  testDir: "sap-tests",
  timeout: 60_000,
  retries: 0,
  reporter: "list", // list | junit | json | html
  outputDir: "sap-results",
  use: { surface: "webgui", system: "ABA", write: "off", screenshots: true },
});
```

Run them:

```sh
npx sap-gui test                     # every *.sap.ts under testDir
npx sap-gui test sap-tests/va03.sap.ts --reporter junit
npx sap-gui test --grep "order" --project s4
npx sap-gui test --list                # what would run
```

The runner finds `sap.config.ts` (or `.js`, `.mjs`, `.json`) by walking up
from the current folder. The `sap` fixture connects to SAP only for a test
or hook that takes it as a parameter. A test that passes on a retry is
reported as flaky; finding no tests exits with 1. The `html` reporter
writes `sap-results/index.html`, which links each test's trace page.

Flags: `--config <file>`, `--project <p>`, `--reporter list,junit,json,html`,
`--grep <re>`, `--retries <n>`, `--list`. Test files match
`**/*.sap.{ts,js,mjs}` under `testDir` (default: the config's folder).

Tests run one at a time (one SAP session is one user's screen). Each test's
trace goes to `sap-results/<test>/`; open it with the
[trace viewer](trace-viewer.md). `npx sap-gui init` writes a config and an
example test to start from ([CLI](../reference/cli.md)).

In CI, the machine running the tests needs an SAP session open (a Web GUI
tab in Chrome, or SAP GUI on a Windows runner). Keep `write` at `off` unless
the test system is meant to be changed.
