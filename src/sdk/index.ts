/** The scripting API (see session.ts). */
export { callOf, codeOf, draftTest, type DraftOptions } from "./code.js";
export { expect, ExpectError, type ExpectOptions } from "./expect.js";
export { ControlLocator, type ControlState, GridLocator, type GridState, parseGrid, StatusLocator, type StatusState } from "./locators.js";
export { type ConfirmRequest, connect, type ConnectOptions, type Done, policyOf, Refused, Sap, SDK_VERSION } from "./session.js";
