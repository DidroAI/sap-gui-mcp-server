// A stand-in for ps/host.ps1 in host.test.ts: same line protocol, no SAP.
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.op === "die") process.exit(3);
  if (req.op === "hang") continue;
  // Never answers and outlives its stdin, as a host stuck in a COM call would.
  if (req.op === "stuck") {
    setInterval(() => {}, 1000);
    continue;
  }
  // Answers after `ms`, with the time it was received.
  if (req.op === "slow") {
    const at = Date.now();
    await new Promise((r) => setTimeout(r, req.ms));
    console.log(JSON.stringify({ id: req.id, ok: true, result: { pid: process.pid, at } }));
    continue;
  }
  // Ignores SIGTERM and answers the request late, as a killed process that still writes would.
  if (req.op === "linger") {
    process.on("SIGTERM", () => {});
    setTimeout(() => {
      console.log(JSON.stringify({ id: req.id, ok: true, result: { pid: process.pid, late: true } }));
      console.log(JSON.stringify({ id: req.id + 1, ok: true, result: { pid: process.pid, late: true } }));
      process.exit(0);
    }, req.ms);
    continue;
  }
  if (req.op === "noise") console.log("not json");
  const answer = req.op === "fail" ? { id: req.id, ok: false, error: "NOT_FOUND: no control x" } : { id: req.id, ok: true, result: { pid: process.pid, echo: req.text ?? null } };
  console.log(JSON.stringify(answer));
}
