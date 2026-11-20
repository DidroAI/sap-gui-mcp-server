/** The scripting API (see session.ts). */
export { callOf, codeOf, draftTest, type DraftOptions } from "./code.js";
export { expect, ExpectError, type ExpectOptions } from "./expect.js";
export { bareLabel, ButtonLocator, ControlLocator, type ControlState, findButton, GridLocator, type GridState, parseGrid, StatusLocator, type StatusState } from "./locators.js";
export { type ConfirmRequest, connect, type ConnectOptions, type Done, isAt, type Place, policyOf, Refused, Sap, SDK_VERSION } from "./session.js";
export { type ReplayDrift, runVerified, type RunVerifiedCodeOptions, type RunVerifiedCodeResult, type RunVerifiedOptions, type RunVerifiedResult, type VerifiedCode } from "./cached.js";
export { emptyLock, identity, LOCK_FORMAT, type Lock, type LockAction, type LockRef, type LockRepair, type LockStep, type LockTest, lockPathFor, parseLock, readLock, serializeLock } from "./lock.js";
export { type AppliedRepair, Drift, type DriftInfo, type DriftPhase, type LockMode, Verifier, type VerifyOptions, type VerifySummary } from "./verify.js";
