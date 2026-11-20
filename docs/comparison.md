# Comparison

How this server relates to other tools an agent or a test team can use on
SAP screens. Facts about other tools are as of November 2026, from their
public docs and READMEs, linked in each row. They change; check the source
before you rely on a row. Facts about this server come from its code and
its [README](https://github.com/DidroAI/sap-gui-mcp-server/blob/main/README.md).

No measured comparison exists yet: the [benchmark](benchmarks.md) has not
had a full run.

## Playwright MCP and other browser MCP servers

[Playwright MCP](https://github.com/microsoft/playwright-mcp) is a generic
browser MCP server. Per its README, it lets a model work with web pages
"through structured accessibility snapshots", without screenshots or
vision models (a `vision` capability adds coordinate-based input).

| | Playwright MCP | sap-gui-mcp-server |
| --- | --- | --- |
| What it drives | any web page | SAP screens: SAP GUI for Windows, Web GUI, Fiori |
| What the model reads | the page's accessibility tree | SAP's model of the screen: SAP control ids, labels, values, edit state, status bar, popups as windows, grid and table rows ([The screen view](concepts/screen-view.md)) |
| Ids the model acts on | references into the snapshot | SAP scripting ids and field names (`ctxtVBAK-AUART`), the same on SAP GUI and Web GUI |
| After an action on the same screen | a new snapshot | only the lines that changed |
| SAP GUI for Windows | no: it is not a browser | yes, through SAP GUI scripting or the network reader |
| Guard on writes to SAP | none specific to SAP | Save, Post, Delete and other writes refused by default (`SAP_WRITE`), transaction and system lists ([Safety model](concepts/safety.md)) |
| Logs on | can fill a logon form like any form | never; works in sessions you opened |
| Record and replay | no SAP test format | `sap_record`, `sap_replay`, exports ([Recording and replay](guides/record-replay.md)) |
| Other web apps | yes | no: non-SAP tabs are left alone |

The two can run side by side: Playwright MCP for the rest of the web, this
server for SAP tabs. [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
is in the same category as Playwright MCP. Both are methods in the
benchmark harness.

## Other SAP GUI MCP servers

Open-source MCP servers for SAP GUI found on GitHub and PyPI in November
2026. The table states what each README says; nothing here was run by us.
Three of them are configured as methods in the benchmark harness, not yet
run.

| Project | Surfaces | How it drives SAP | Logs on | Notes from its README |
| --- | --- | --- | --- | --- |
| [kts982/mcp-sap-gui](https://github.com/kts982/mcp-sap-gui) (PyPI [`mcp-sap-gui`](https://pypi.org/project/mcp-sap-gui/)) | SAP GUI for Windows | SAP GUI Scripting API; Python, run with `uvx` | no: attaches to sessions opened in SAP Logon | saves wait for the user's yes (MCP elicitation); transaction policy, read-only mode, audit log; screenshots |
| [Hochfrequenz/sapgui.mcp](https://github.com/Hochfrequenz/sapgui.mcp) | SAP GUI for Windows (Web GUI moved out after v0.20.0) | SAP GUI COM scripting | yes: `sap_login` with credentials from a `systems.json` file | `sap_run_script` runs sandboxed Python against the COM API; built-in tools for SE16, SE09, SM37, ST22 and others (EN, DE, IT logon); multi-session tools; screenshots |
| [Hochfrequenz/sapwebgui.mcp](https://github.com/Hochfrequenz/sapwebgui.mcp) | Web GUI | Chrome, through the DevTools protocol | yes: `sap_login` from `systems.json` | Windows, macOS, Linux; the README says it is looking for a maintainer |
| [mario-andreschak/mcp-sap-gui](https://github.com/mario-andreschak/mcp-sap-gui) | SAP GUI for Windows | one configured session: COM scripting tools, plus mouse and keyboard tools on screenshot pixels; optional GuiXT InputScripts | can open a connection and fill the logon from `SAP_USER`, `SAP_PASSWORD`; also attaches to an existing session | reads up to 300 COM controls per screen; password fields redacted |
| [toni-ramchandani/sapient-mcp](https://github.com/toni-ramchandani/sapient-mcp) | SAP GUI for Windows | the RoboSAPiens library (Robot Framework) | optional auto-login from environment variables | `codegen` capability returns a Robot Framework script of the session; JSON snapshot of the window; no licence file found |
| [jduncan8142/sap_gui_mcp](https://github.com/jduncan8142/sap_gui_mcp) | SAP GUI for Windows | SAP GUI Scripting API, FastMCP | yes: `login_to_sap`, with credentials or SSO | Python 3.13 or later |
| [ethanhan2014/sap-gui-mcp](https://github.com/ethanhan2014/sap-gui-mcp) | SAP GUI for Windows | scripting through pywin32 | no: attaches to the first open session | nine tools; mutating tools return the screen state and status bar |
| [piyushsteelcase-design/mcp-sap-gui-advanced](https://github.com/piyushsteelcase-design/mcp-sap-gui-advanced) | SAP GUI | 22 tools in Python and TypeScript, for Claude Desktop | yes: `sap_connect` with credentials | |
| [nelz0n/mcp-sap-gui](https://github.com/nelz0n/mcp-sap-gui) | SAP GUI for Windows | a GitHub fork of kts982/mcp-sap-gui | | |

What this server does that these READMEs do not describe, in one place:

- **Three surfaces with one view and one action set:** SAP GUI for Windows,
  Web GUI and Fiori, including Web GUI apps inside the launchpad.
- **SAP GUI without scripting** (experimental): the network reader decodes
  SAP's DIAG traffic through a local SAProuter, for systems where
  `sapgui/user_scripting` is off.
- **A guard that fails closed** on every surface, rating each action read,
  navigate or commit from the screen as it is, with system, transaction and
  origin lists.
- **Record and replay with exports** to Cloud ALM, VBS, Playwright and
  Gherkin.
- **Never logs on**, on any surface.

What some of them do that this server does not: log on from stored
credentials (Hochfrequenz, jduncan8142, mario-andreschak, sapient-mcp,
piyushsteelcase-design), run agent-written scripts in one call
(Hochfrequenz `sap_run_script`), transaction-specific tools (Hochfrequenz),
an audit log and a read-only switch (kts982), Robot Framework output
(sapient-mcp).

The [marianfoo/sap-ai-mcp-servers](https://github.com/marianfoo/sap-ai-mcp-servers)
list keeps a wider catalogue of SAP MCP servers.

## Tosca, Worksoft and SAP's own test tools

These are a different category: test-automation suites for test teams,
with their own test repositories, scanners or recorders, test data
management and reporting, most of them licensed. This server is an MCP
server for an agent working in open SAP sessions; its record and replay is
a prototype that overlaps with a small part of what these suites do.

| Tool | What it is (from its public docs) | Overlap with this server |
| --- | --- | --- |
| [Tricentis Tosca / Tricentis Test Automation for SAP](https://documentation.tricentis.com/sap/tta/1500/en/content/resources/webhelp/about_tricentis_tosca.htm) | commercial test automation; scans SAP screens into modules and builds test cases from them; GUI and non-GUI tests, test data | a recording is a step list with SAP control ids and data; no converter to Tosca exists |
| [Worksoft Certify](https://www.worksoft.com/) | commercial, codeless test automation for SAP and other enterprise applications | the same: no open file format to write; no converter |
| [eCATT](https://help.sap.com/saphelp_nw73/helpdata/en/49/6d2fa0e0221ec6e10000000a42189b/content.htm) (extended Computer Aided Test Tool) | SAP's tool in the ABAP system for functional tests, with SAP GUI recording, for SAP GUI for Windows and SAP GUI for Java | record and replay of SAP GUI transactions; this server's VBS export is SAP GUI scripting, not eCATT |
| [CBTA](https://help.sap.com/saphelp_sm72_sp03/helpdata/en/99/ed237d141240cc839abc6c9efbd6a4/content.htm) (Component-Based Test Automation) | SAP Solution Manager's recorder and player; tests are eCATT-compatible. SAP says CBTA is supported as long as Solution Manager is, and not extended to cloud products ([SAP](https://support.sap.com/en/alm/partners/test-automation.html)) | record and replay |
| [SAP Cloud ALM test management](https://support.sap.com/en/alm/sap-cloud-alm/implementation/sap-cloud-alm-implementation-expert-portal/testmanagement.html) | manual and automated tests; automated tests are synchronised from and run in a connected tool, such as the S/4HANA Cloud test automation tool or [Tricentis Test Automation for SAP](https://support.sap.com/en/alm/partners/test-automation.html). SAP Cloud ALM has no automation engine of its own | `export --to calm` writes a manual test case, shaped as the input of a Cloud ALM MCP tool. Nothing in this server calls Cloud ALM, and it is not an automation provider for it |

Where this server fits next to them:

- **Exploration by an agent, then a test.** The agent works in the screens
  in plain language; the run that worked becomes a test file, with checks
  marked on the screen.
- **Replay without a model,** under the same write guard, with JUnit output
  for CI ([Recording and replay](guides/record-replay.md)).
- **Hand-over:** a Cloud ALM manual test case, a SAP GUI script, a
  Playwright spec or a Gherkin feature, for the tools a test team already
  uses.

It does not offer what the suites are bought for: test management, test
data management, scheduling across systems, impact analysis, or support
from a vendor.
