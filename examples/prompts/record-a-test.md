# Record a test while the agent works

**Settings:** `SAP_WRITE=off` for a read-only test. `SAP_RECORD_DIR` names
the folder for recordings (default `./sap-tests` in the server's working
directory).

## Prompt

> Record a test named "VA03 display order" while you do this:
>
> 1. identify a dedicated, clean test session, verify its system and client, use its exact session id for recording, actions, checks and replay, and start the recording with `sap_record` (`op: start`);
> 2. open VA03 with `/nVA03`, enter order 4711 and press Enter;
> 3. on the overview, add checks: the window title contains the order
>    number, and the sold-to party field equals 100001;
> 4. make the order number and the sold-to party variables named `order`
>    and `customer`;
> 5. press Back, then stop the recording and tell me what `stop` reported.
>
> Then replay it once with `sap_replay` and tell me whether every step
> passed. Finally export it to Gherkin.

## What to expect

A file `va03-display-order.saptest.json` in `SAP_RECORD_DIR`, like the one
in [../recorded-test](../recorded-test/). Replay runs with no model:

```sh
npx -y sap-ui-automation replay sap-tests/va03-display-order.saptest.json --session "<test-session-id>" --var order=4712
```

The recording holds what was typed and checked: treat it like the system's
data.
