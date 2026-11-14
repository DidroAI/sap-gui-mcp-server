// Copies non-TypeScript assets (PowerShell scripts) next to the compiled code.
import { cpSync, existsSync } from "node:fs";
if (existsSync("src/sapgui/ps")) cpSync("src/sapgui/ps", "dist/sapgui/ps", { recursive: true });
