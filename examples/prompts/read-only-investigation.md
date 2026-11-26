# Read-only investigation

**Settings:** `SAP_WRITE=off` (read-only; the default, `confirm`, would ask before each write). Optional:
`SAP_ALLOW_TCODES=VA03,VL03N,VF03,MMBE` to keep the agent to these
transactions.

**Before:** log on to SAP GUI, Web GUI or Fiori yourself.

## Prompt

> Sales order 4711 has not been delivered and the customer is asking why.
> In SAP, find out:
>
> 1. the order's items, quantities, requested delivery dates and the
>    status of each item (VA03);
> 2. whether a delivery exists for it, and its status (document flow in
>    VA03, then VL03N);
> 3. the stock of each material at the delivering plant (MMBE).
>
> Only display. Do not change or save anything; if a screen offers to save,
> leave it with Back. Use `sap_look` with `id` and `rows` to read long lists
> instead of scrolling by hand. When you are done, give me a short answer
> with the reason, and the transactions and documents you looked at.

## What to expect

The agent opens each transaction with `okcode`, reads the screens with
`sap_look`, and answers. With writes off, any action that might save is
refused by the server, whatever the agent tries.
