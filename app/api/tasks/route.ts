import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function walk(dir: string, files: string[] = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (entry.name.endsWith(".jsonl")) files.push(full);
  }
  return files;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item: any) => item?.text || item?.input_text || "").join(" ");
}

export async function GET() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const root = path.join(codexHome, "sessions");
  const threadState = new Map<string, { archived: boolean; updatedAt?: string; model?: string; reasoning?: string; cwd?: string }>();
  for (const databasePath of [path.join(codexHome, "state_5.sqlite"), path.join(codexHome, "sqlite", "state_5.sqlite")]) {
    try {
      const raw = execFileSync("/usr/bin/sqlite3", ["-json", databasePath, "SELECT id, archived, recency_at_ms, updated_at_ms, model, reasoning_effort, cwd FROM threads"], { encoding: "utf8", timeout: 5000 });
      const rows = JSON.parse(raw || "[]") as Array<{ id: string; archived: number; recency_at_ms?: number; updated_at_ms?: number; model?: string; reasoning_effort?: string; cwd?: string }>;
      for (const row of rows) {
        const timestamp = row.recency_at_ms || row.updated_at_ms;
        threadState.set(row.id, { archived: row.archived === 1, updatedAt: timestamp ? new Date(timestamp).toISOString() : undefined, model: row.model, reasoning: row.reasoning_effort, cwd: row.cwd });
      }
      break;
    } catch {}
  }
  const titleIndex = new Map<string, { title: string; updatedAt?: string }>();
  const indexSource = await fs.readFile(path.join(codexHome, "session_index.jsonl"), "utf8").catch(() => "");
  for (const raw of indexSource.split("\n")) {
    if (!raw) continue;
    try {
      const row = JSON.parse(raw);
      if (row.id && row.thread_name) titleIndex.set(row.id, { title: row.thread_name, updatedAt: row.updated_at });
    } catch {}
  }
  const files = await walk(root);
  const recent = await Promise.all(files.map(async (file) => ({ file, stat: await fs.stat(file) })));
  recent.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const tasks = [];
  for (const { file, stat } of recent.slice(0, 80)) {
    const source = await fs.readFile(file, "utf8").catch(() => "");
    let id = "";
    let cwd = "";
    let title = "";
    for (const raw of source.split("\n").slice(0, 120)) {
      if (!raw) continue;
      try {
        const row = JSON.parse(raw);
        if (row.type === "session_meta") { id = row.payload?.id || row.payload?.session_id || ""; cwd = row.payload?.cwd || ""; }
        if (!title && row.payload?.role === "user") title = textFromContent(row.payload.content);
        if (!title && row.type === "event_msg" && row.payload?.type === "user_message") title = row.payload.message || "";
      } catch {}
      if (id && title) break;
    }
    title = title.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const indexed = titleIndex.get(id);
    const state = threadState.get(id);
    if (id && !state?.archived && (indexed?.title || title)) tasks.push({ id, title: (indexed?.title || title).slice(0, 64), cwd: state?.cwd || cwd, updatedAt: state?.updatedAt || indexed?.updatedAt || stat.mtime.toISOString(), model: state?.model, reasoning: state?.reasoning });
  }
  const discovered = new Set(tasks.map((task) => task.id));
  for (const [id, entry] of titleIndex) {
    const state = threadState.get(id);
    if (!discovered.has(id) && !state?.archived) tasks.push({ id, title: entry.title.slice(0, 64), cwd: state?.cwd || "", updatedAt: state?.updatedAt || entry.updatedAt, model: state?.model, reasoning: state?.reasoning });
  }
  tasks.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return Response.json({ tasks });
}
