// The same check as a test for the runner: npx sap-ui-automation test examples/sdk
import { expect, test } from "sap-ui-automation/test";

test("order 4711 displays without an error", async ({ sap }) => {
  await sap.okcode("/nVA03");
  await sap.set("VBAK-VBELN", "4711");
  await sap.key("Enter");
  await expect(sap.status()).not.toBeError();
  await expect(sap).toHaveTransaction("VA03");
});
