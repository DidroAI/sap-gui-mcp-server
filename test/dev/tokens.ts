/**
 * Development only: counts tokens with the Anthropic count_tokens API, for
 * the soak and measure scripts. Without ANTHROPIC_API_KEY it answers
 * undefined and the scripts report characters.
 *
 *   ANTHROPIC_API_KEY        the key (never printed)
 *   ANTHROPIC_BASE_URL       default https://api.anthropic.com/v1
 *   ANTHROPIC_WORKSPACE_ID   sent as anthropic-workspace-id when set (Claude Platform on AWS)
 *   TOKEN_MODEL              default claude-opus-5-5
 */
const env = process.env;
const BASE = (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
const MODEL = env.TOKEN_MODEL ?? "claude-opus-5-5";

async function one(text: string): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        ...(env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: text || "." }] }),
    });
    if (r.ok) return ((await r.json()) as { input_tokens: number }).input_tokens;
    if (attempt >= 4 || (r.status !== 429 && r.status < 500)) throw new Error(`count_tokens answered ${r.status}`);
    await new Promise((f) => setTimeout(f, 1000 * (attempt + 1)));
  }
}

export const tokenModel = MODEL;
export const canCountTokens = () => !!env.ANTHROPIC_API_KEY;

/**
 * Tokens of each text, as the model counts a user message holding it, minus
 * the fixed cost of an empty message. Undefined when no key is set or the
 * API cannot be reached.
 */
export async function countTokens(texts: string[]): Promise<number[] | undefined> {
  if (!canCountTokens()) return undefined;
  try {
    const overhead = (await one("x")) - 1;
    const out: number[] = new Array(texts.length).fill(0);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < texts.length; i = next++) out[i] = Math.max(0, (await one(texts[i] ?? "")) - overhead);
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return out;
  } catch (e) {
    console.error(`tokens not counted: ${(e as Error).message}`);
    return undefined;
  }
}
