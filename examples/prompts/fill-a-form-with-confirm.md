# Fill a form, with your yes before saving

**Settings:** `SAP_WRITE=confirm`. Use a test system and an interactive MCP client that shows elicitation prompts. Codex Full Access can accept them automatically.

**Before:** log on yourself and open the transaction, or let the agent
open it.

## Prompt

> On the test system, create a standard sales order (VA01, order type OR)
> for sold-to party 100001, sales organisation 1000, distribution channel
> 10, division 00, with one item: material M-01, quantity 5.
>
> Fill in the fields, press Enter after each screen and read the status
> bar. If SAP shows a warning or an error, stop and tell me what it says.
> Before you save, show me the values on the overview screen. Wait for my explicit approval in chat before sending the Save action. After saving, tell me the order number from the status bar.

## What to expect

Typing, Enter and tabs run without asking. Before Save runs, your MCP
client asks you, with the action, the system and the transaction. The yes
is for that one action, on that screen; you have five minutes to answer.
A client that does not support MCP elicitation cannot ask, and the save is
refused: the agent then tells you what it would have saved.
