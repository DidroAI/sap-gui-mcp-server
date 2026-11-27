# A recorded test

[`va03-display-order.saptest.json`](va03-display-order.saptest.json) is a
small recorded test in the `sap-gui-test/1` format: open a sales order in
VA03 on Web GUI, check its title, its sold-to party and that it has a net
value, then go Back. It only reads: every step is `navigate`, nothing is
saved.

It is synthetic. The system (`DEM`, client `100`), the order (`4711`) and
the customer (`100001`) are made up. To run it, pass an order and its
sold-to party that exist on your system.

The format is described in
[Recording and replay](../../docs/guides/record-replay.md).

## Replay it

Log on to Web GUI in Chrome yourself (the server never logs on): in the
SAP window that `npx -y sap-ui-automation browser` opens, or in the Chrome
of another browser mode (see [Chrome](../../docs/guides/chrome.md#choose-a-browser-mode)). List sessions with `npx -y sap-ui-automation sessions` and verify the id of a clean test session. Replay starts with `/nVA03`, which replaces the current transaction.

```sh
npx -y sap-ui-automation replay examples/recorded-test/va03-display-order.saptest.json \
  --session "<test-session-id>" --var order=<an order on your system> --var customer=<its sold-to party>
```

Each step prints pass or fail; the exit code is 0 when all passed. Add
`--junit report.xml` for a CI report, `--json` for the result as data, and
`--loose` if your system's screen numbers differ.

The test needs no write permission: it runs with the default
`SAP_WRITE=confirm`, or with `off`. With `SAP_ALLOW_SYSTEMS` or `SAP_ALLOW_TCODES` set, `DEM`
and `VA03` are not special: your own system and VA03 must be allowed.

From an agent, copy the file into `SAP_RECORD_DIR` (default `./sap-tests`
in the server's working directory) and ask:

```
sap_replay {"session":"<test-session-id>","name":"VA03 display order","variables":{"order":"...","customer":"..."}}
```

## Export it

```sh
npx -y sap-ui-automation export examples/recorded-test/va03-display-order.saptest.json --to gherkin --out -
```

Targets: `calm` (SAP Cloud ALM manual test case), `vbs` (SAP GUI scripting),
`playwright` and `playwright-sap` (a Playwright spec for Web GUI),
`gherkin`. Without `--out`, the file is written next to the recording. The
Gherkin export reads:

```gherkin
Feature: VA03 display order
  Synthetic example: open a sales order in VA03 and check its header. Read-only. The system, order and customer numbers are made up.

  Scenario Outline: VA03 display order
    Given I am logged on to DEM, client 100 with SAP GUI for HTML (Web GUI)
    When I start transaction VA03 (enter /nVA03 in the command field)
    Then the screen "Display Sales Documents" appears
    And the transaction is VA03
    When I enter "<order>" in the field "Order" (VBAK-VBELN)
    And I press Enter
    Then the screen "Display Standard Order <order>: Overview" appears
    And the window title contains "<order>"
    And the field "Sold-To Party" (KUAGV-KUNNR) is "<customer>"
    And the field "Net Value" (VBAK-NETWR) matches "^[0-9.,]+$"
    When I press F3 (Back)
    Then the screen "Display Sales Documents" appears

    Examples:
      | order | customer |
      | 4711 | 100001 |
```

The Playwright spec logs on by itself, unlike the server. It reads the URL,
user and password from your environment when you run it:

```sh
SAP_WEBGUI_URL=https://sap.example.com/sap/bc/gui/sap/its/webgui?sap-client=100 \
SAP_USER=... SAP_PASSWORD=... npx playwright test
```

## Record your own

Ask the agent to record while it works (see
[record-a-test.md](../prompts/record-a-test.md)), or set `SAP_RECORD=on`.
A recording holds the values typed and the texts checked: treat it like the
system's data, and replace them before you share one.
