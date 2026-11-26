# Compare a Fiori app with its GUI transaction

**Settings:** `SAP_WRITE=off`. `SAP_ALLOW_ORIGINS` with your SAP host, for
example `https://sap.example.com`.

**Before:** log on to the Fiori launchpad in Chrome (in the SAP window, or
the Chrome of your [browser mode](../../docs/guides/chrome.md#choose-a-browser-mode))
and to SAP GUI or Web GUI for the same system.

## Prompt

> I have two SAP sessions open: the Fiori launchpad and SAP GUI, on the
> same system. List them with `sap_sessions`, inspect both screens, and verify
> their system and client. Use each exact session id for its calls. Preserve any unsaved work.
>
> For purchase order 4500000001:
>
> 1. in Fiori, open "Manage Purchase Orders", find the order and read its
>    header and items;
> 2. in SAP GUI, open ME23N for the same order and read the same data.
>
> Make a table of the fields both show (supplier, document date, net value,
> items with material, quantity, price, delivery date), with the value on
> each side. Then list the fields only one of them shows. Only display;
> change nothing.

## What to expect

The agent addresses each session by id. The view of
both is the same text format, so the comparison is field by field. Say if
a value differs only in format (decimal comma, date order).
