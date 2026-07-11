import { execFileSync } from "node:child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const CODEX_BIN = process.env.CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";

export async function GET() {
  try {
    const raw = execFileSync(CODEX_BIN, ["debug", "models"], { encoding: "utf8", timeout: 8000 });
    const parsed = JSON.parse(raw);
    const catalog = Array.isArray(parsed) ? parsed : parsed.models || [];
    const models = catalog.map((item: any) => ({
      id: item.slug || item.id || item.model,
      name: item.display_name || item.name || item.slug,
      reasoning: (item.supported_reasoning_levels || item.supported_reasoning_effort || []).map((level: any) => typeof level === "string" ? level : level.effort || level.value).filter((level: string) => level && level !== "minimal"),
    })).filter((item: any) => item.id);
    return Response.json({ models });
  } catch {
    return Response.json({ models: [
      { id: "gpt-5.4", name: "GPT-5.4", reasoning: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", reasoning: ["minimal", "low", "medium", "high"] },
    ] });
  }
}
