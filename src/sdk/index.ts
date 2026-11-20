/** The scripting API (see session.ts). */
export { callOf, codeOf, draftTest, type DraftOptions } from "./code.js";
export { expect, ExpectError, type ExpectOptions } from "./expect.js";
export { bareLabel, ButtonLocator, ControlLocator, type ControlState, findButton, GridLocator, type GridState, parseGrid, StatusLocator, type StatusState } from "./locators.js";
export { type ConfirmRequest, connect, type ConnectOptions, type Done, isAt, type Place, policyOf, Refused, Sap, SDK_VERSION } from "./session.js";
export { type Drift, runVerified, type RunVerifiedOptions, type RunVerifiedResult } from "./cached.js";
