import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODEX_BIN = process.env.CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
const ALLOWED_REASONING = new Set(["minimal", "low", "medium", "high", "xhigh"]);

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) return new Response("A prompt is required", { status: 400 });
  if (body.prompt.length > 30000) return new Response("Prompt is too long", { status: 400 });
  const model = typeof body.model === "string" && /^[a-zA-Z0-9._-]+$/.test(body.model) ? body.model : "gpt-5.4";
  const requestedReasoning = ALLOWED_REASONING.has(body.reasoning) ? body.reasoning : "medium";
  const reasoning = requestedReasoning === "minimal" ? "low" : requestedReasoning;
  const taskId = typeof body.taskId === "string" && /^[a-zA-Z0-9._-]+$/.test(body.taskId) ? body.taskId : null;
  const ephemeral = body.ephemeral === true;
  const requestedWorkspace = typeof body.workspace === "string" && body.workspace.trim() ? body.workspace.trim() : process.cwd();
  const expandedWorkspace = requestedWorkspace === "~" ? os.homedir() : requestedWorkspace.startsWith("~/") ? path.join(os.homedir(), requestedWorkspace.slice(2)) : requestedWorkspace;
  if (!path.isAbsolute(expandedWorkspace)) return new Response("Workspace must be an absolute directory path", { status: 400 });
  const workspace = path.resolve(expandedWorkspace);
  try {
    if (!statSync(workspace).isDirectory()) return new Response("Workspace path is not a directory", { status: 400 });
  } catch {
    return new Response("Workspace directory does not exist", { status: 400 });
  }
  const shared = ["--json", "-m", model, "-c", `model_reasoning_effort=${JSON.stringify(reasoning)}`];
  const args = taskId
    ? ["exec", "resume", ...shared, taskId, "-"]
    : ["exec", ...shared, ...(ephemeral ? ["--ephemeral"] : []), "-C", ".", "-"];

  const encoder = new TextEncoder();
  let child: ReturnType<typeof spawn>;
  const stream = new ReadableStream({
    start(controller) {
      try {
        child = spawn(CODEX_BIN, args, { cwd: workspace, env: { ...process.env, RUST_LOG: process.env.RUST_LOG || "error" }, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Could not launch Codex" })}\n`));
        controller.close();
        return;
      }
      child.stdout?.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
      child.stderr?.on("data", (chunk) => {
        const message = chunk.toString();
        if (!message.includes(" WARN ")) controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message })}\n`));
      });
      child.on("error", (error) => {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message: error.message })}\n`));
        controller.close();
      });
      child.on("close", (code) => {
        if (code && code !== 0) controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message: `Codex exited with code ${code}` })}\n`));
        controller.close();
      });
      child.stdin?.end(body.prompt);
      request.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    },
    cancel() { if (child && !child.killed) child.kill("SIGTERM"); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
