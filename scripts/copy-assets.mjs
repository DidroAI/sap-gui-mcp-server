// Copies non-TypeScript assets (PowerShell scripts) next to the compiled code.
import { cpSync, existsSync } from "node:fs";
if (existsSync("src/sapgui/ps")) cpSync("src/sapgui/ps", "dist/sapgui/ps", { recursive: true });
if (existsSync("src/sapgui-diag/ps")) cpSync("src/sapgui-diag/ps", "dist/sapgui-diag/ps", { recursive: true });
