// A stand-in for ps/host.ps1 in host.test.ts: same line protocol, no SAP.
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.op === "die") process.exit(3);
  if (req.op === "hang") continue;
  if (req.op === "noise") console.log("not json");
  const answer = req.op === "fail" ? { id: req.id, ok: false, error: "NOT_FOUND: no control x" } : { id: req.id, ok: true, result: { pid: process.pid, echo: req.text ?? null } };
  console.log(JSON.stringify(answer));
}
