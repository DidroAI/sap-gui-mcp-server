# Contributing

Thank you for helping. Bug reports, fixes, new screens the view gets wrong,
and words in more logon languages are all welcome.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Never put SAP data in an issue or a pull request

Screens, recordings, DIAG captures and logs from a real system hold your
company's data, and DIAG captures can hold a logon. Before you paste a
view or attach a file, replace names, numbers and texts with made-up ones.
Test fixtures in this repository are synthetic, and must stay so.

## Set up

You need [Bun](https://bun.sh) 1.4 or later (the tests and the lockfile)
and Node.js 22 or later (the built server runs on plain Node).

```sh
git clone https://github.com/DidroAI/sap-gui-mcp-server.git
cd sap-gui-mcp-server
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
node dist/cli.js --help
```

`bunfig.toml` refuses packages published less than seven days ago. Pin new
dependencies to an exact version at least that old.

## Run it without an SAP system

Everything CI runs needs no SAP system and no SAP GUI:

| What | How | Needs |
| --- | --- | --- |
| Unit tests: view, ids, diff, guard and the commit rule, registry, server, record and replay, DIAG decoder | `bun run test` | nothing |
| Web GUI reader in a browser, on synthetic pages | `SAP_TEST_CHROME=/path/to/chrome bun run test` | a Chrome or Chromium binary; skipped without it |
| PowerShell scripts parse | part of `bun run test` | Windows; skipped elsewhere |
| The built server, its PowerShell host and COM, against a fake SAP GUI | `bun run build && node test/sapgui/e2e.mjs` | Windows |
| The benchmark's task files and checkers | `bun run test:bench` | nothing |

The fake SAP GUI and its fixtures are described in
[test/sapgui/README.md](test/sapgui/README.md). The text view of each fake
screen is held to a golden file in `test/sapgui/fixtures/expected/`; after a
change to the format that is meant, write them again with
`UPDATE_EXPECTED=1 bun test test/sapgui/format.test.ts` and review the diff.

To try the server by hand, point an MCP client at your build
(`node /path/to/dist/cli.js`), or use the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
npx @modelcontextprotocol/inspector node dist/cli.js
```

## With an SAP system

If you have a test system, these scripts check against it. They read a
password from a file and never print it, and they write screen content only
where you tell them to: keep that out of Git.

- `test/dev/webgui-logon.ts`, `test/dev/fiori-logon.ts`: log a throwaway
  Chrome on to a test system.
- `test/dev/soak.ts`: walks a logged-on Web GUI session through about sixty
  read-only steps and reports failures, time and tokens per step.
- `test/dev/measure.ts`: counts what each rule of the compact view saves.
- `node test/sapgui/e2e.mjs --real`: reads (never acts on) the SAP GUI for
  Windows session that is open.
- `scripts/diag-dev/replay.ts`: replays a DIAG capture
  (`SAP_DIAG_CAPTURE`) through the decoder.

The token counts use the Anthropic `count_tokens` API when
`ANTHROPIC_API_KEY` is set.

## Where things are

| Folder | What |
| --- | --- |
| `src/core/` | what every surface shares: actions, the guard, the commit words, the compact view, ids, diffs, the registry of sessions |
| `src/sapgui/` | SAP GUI for Windows through scripting; `ps/` is the PowerShell host |
| `src/sapgui-diag/`, `src/diag/` | SAP GUI without scripting: the local SAProuter and the DIAG decoder |
| `src/webgui/`, `src/fiori/`, `src/browser/` | Web GUI and Fiori in Chrome, and attaching to Chrome |
| `src/record/` | record, replay, export |
| `src/server.ts`, `src/cli.ts`, `src/cli/` | the MCP tools, the command line, `setup` and `doctor` |
| `skills/` | the agent skill |
| `bench/` | the benchmark harness (its own package; not published) |

## Add a surface

A surface is a kind of SAP front end. It implements two interfaces from
[src/core/types.ts](src/core/types.ts):

- `Surface`: `discover()` lists the sessions open right now (it never logs
  on and never opens anything), `open()` returns a `Driver` on one of them,
  `doctor()` returns setup checks with the one thing to change when a check
  fails.
- `Driver`: `look()` returns the screen in the shared text format (see
  `src/core/compact.ts`), `assess()` classifies an action as read, navigate
  or commit **before** it runs, `act()` runs it, plus `refresh()`,
  `screenshot()` and `close()`.

Then:

1. Add its name to `SurfaceName` in `src/core/types.ts` and to
   `SURFACE_NAMES` in `src/core/registry.ts`, and build it in
   `surfacesFromEnv` (`src/surfaces.ts`).
2. Make `assess` fail closed: anything it does not know to be safe is a
   commit. Reuse the words in `src/core/words.ts`. Refuse password fields
   and logon screens.
3. Test without the real front end: a fake of what the surface talks to
   (see `test/sapgui/` for SAP GUI, synthetic pages for Web GUI, and
   `test/fakes.ts` for a surface in memory), with tests for `assess` on
   every kind of control.
4. Document its requirements in the README and add a line to the
   CHANGELOG.

Open an issue first for a new surface: it is a large change, and worth
agreeing on before you write it.

## Pull requests

- One change per pull request, with tests. `bun run typecheck`,
  `bun run test` and `bun run build` must pass.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat(webgui): ...`, `fix(sapgui): ...`, `docs: ...`).
- A change to what the guard allows needs a test that shows the action is
  still refused when it should be.
- A user-visible change gets a line in `CHANGELOG.md` under "unreleased".
