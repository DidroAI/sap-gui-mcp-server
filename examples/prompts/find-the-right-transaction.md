# Explore an unfamiliar screen

**Settings:** `SAP_WRITE=off`.

**Before:** open the screen you want explained.

## Prompt

> Look at my active SAP screen with `sap_look`. Tell me:
>
> - which transaction and screen this is, and what it is for;
> - which fields are required, and what each expects (use F4 value help on
>   a field if you are not sure; do not choose a value);
> - which buttons and menu entries would save or post something, and which
>   only display.
>
> Do not type anything and do not press any button that is not value help.

## What to expect

A short guide to the screen. The answer on what saves comes from the
agent's reading; the server's own rule is stricter (anything not known to
be safe counts as a write), and it decides what runs.
