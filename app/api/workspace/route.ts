import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

export async function GET() {
  return Response.json({ workspace: process.cwd() });
}

export async function POST() {
  if (process.platform !== "darwin") return Response.json({ error: "Folder browsing is currently available on macOS. Enter the absolute path directly." }, { status: 501 });
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a Codex workspace")'], { timeout: 120000 });
    const workspace = stdout.trim().replace(/\/$/, "") || "/";
    return Response.json({ workspace });
  } catch {
    return Response.json({ cancelled: true });
  }
}
