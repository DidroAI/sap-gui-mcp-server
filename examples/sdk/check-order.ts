// A read-only SDK script: attach to a Web GUI session you have open,
// display an order in VA03 and check what SAP shows.
//
//   node examples/sdk/check-order.ts 4711
//
// Needs the SDK (connect, expect), new in this version, and Node 22.6+
// (type stripping). Writes stay refused: SAP_WRITE is off unless you set it.
import { connect, expect } from "sap-ui-automation";

const order = process.argv[2] ?? "4711";

await using sap = await connect({ surface: "webgui" });

await sap.okcode("/nVA03");
await sap.set("VBAK-VBELN", order);
await sap.key("Enter");

await expect(sap.status()).not.toBeError();
await expect(sap).toHaveTransaction("VA03");
console.log(await sap.look());
