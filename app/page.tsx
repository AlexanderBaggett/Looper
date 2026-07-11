"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type LoopType = "infinite" | "conditional";
type Reasoning = "minimal" | "low" | "medium" | "high" | "xhigh";
type Loop = {
  id: string;
  type: LoopType;
  name: string;
  prompt: string;
  goal: string;
  evaluatorModel: string;
  evaluatorReasoning: Reasoning;
};
type Task = { id: string; title: string; cwd?: string; updatedAt?: string; model?: string; reasoning?: Reasoning };
type Model = { id: string; name: string; reasoning: Reasoning[] };
type LogLine = { id: number; time: string; kind: "system" | "input" | "output" | "error" | "eval"; text: string };
type SavedPrompt = Omit<Loop, "id"> & { id: string; savedAt: string };

const WORKSPACE_STORAGE_KEY = "looper.workspace.v1";
const PROMPT_LIBRARY_STORAGE_KEY = "looper.saved-prompts.v1";

const DEFAULT_MODELS: Model[] = [
  { id: "gpt-5.4", name: "GPT-5.4", reasoning: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", reasoning: ["minimal", "low", "medium", "high"] },
];

const starterLoop: Loop = {
  id: "loop-1",
  type: "conditional",
  name: "Ship the feature",
  prompt: "Continue implementing the current task. Inspect the latest state, choose the most useful next action, make the change, and verify your work.",
  goal: "The requested feature is complete, relevant checks pass, and there are no remaining required changes.",
  evaluatorModel: "gpt-5.4-mini",
  evaluatorReasoning: "low",
};

function now() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function compactAge(value: string | undefined, clock: number) {
  if (!value) return "";
  const seconds = Math.max(0, Math.floor((clock - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)}mo`;
  return `${Math.floor(seconds / 31536000)}y`;
}

function newLoop(type: LoopType): Loop {
  return {
    id: crypto.randomUUID(),
    type,
    name: type === "infinite" ? "Repeat prompt" : "Run until done",
    prompt: type === "infinite" ? "Review the current state and make the next useful improvement." : "Continue working toward the goal below. Make concrete progress, then verify the result.",
    goal: type === "conditional" ? "The task is fully complete and verified." : "",
    evaluatorModel: "gpt-5.4-mini",
    evaluatorReasoning: "low",
  };
}

function agentMessageText(event: Record<string, any>): string | null {
  const item = event.type === "item.completed" ? event.item ?? {} : {};
  return item.type === "agent_message" && typeof item.text === "string" ? item.text : null;
}

function compactCommand(command: unknown) {
  const text = Array.isArray(command) ? command.join(" ") : String(command || "command");
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function consoleEventText(event: Record<string, any>): { text: string; kind: LogLine["kind"] } | null {
  if (event.type === "item.completed") {
    const item = event.item ?? {};
    if (item.type === "agent_message" && typeof item.text === "string") return { text: item.text, kind: "output" };
    if (item.type === "command_execution") return { text: `Ran: ${compactCommand(item.command || item.cmd)}`, kind: "system" };
    if (item.type === "file_change") {
      const paths = Array.isArray(item.changes) ? item.changes.map((change: any) => change.path).filter(Boolean) : [];
      return { text: paths.length ? `Updated ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}` : "Applied file changes", kind: "system" };
    }
    if (item.type === "mcp_tool_call") return { text: `Used tool: ${[item.server, item.tool].filter(Boolean).join(" · ") || "MCP tool"}`, kind: "system" };
    if (item.type === "web_search") return { text: `Searched the web${item.query ? `: ${item.query}` : ""}`, kind: "system" };
    if (item.type === "error" && typeof item.message === "string") return { text: item.message, kind: "error" };
  }
  if (event.type === "error" || event.type === "turn.failed") return { text: event.message || event.error?.message || "Codex returned an error", kind: "error" };
  return null;
}

export default function Home() {
  const [loops, setLoops] = useState<Loop[]>([starterLoop]);
  const [selectedId, setSelectedId] = useState(starterLoop.id);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState("new");
  const [models, setModels] = useState<Model[]>(DEFAULT_MODELS);
  const [model, setModel] = useState("gpt-5.4");
  const [reasoning, setReasoning] = useState<Reasoning>("high");
  const [loopRunning, setLoopRunning] = useState(false);
  const [cliRunning, setCliRunning] = useState(false);
  const [iteration, setIteration] = useState(0);
  const [logs, setLogs] = useState<LogLine[]>([
    { id: 1, time: "--:--:--", kind: "system", text: "Looper ready — drag in a loop or press play." },
  ]);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [consoleSize, setConsoleSize] = useState<{ width?: number; height?: number }>({});
  const [clock, setClock] = useState(() => Date.now());
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [savedPromptId, setSavedPromptId] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [browsingWorkspace, setBrowsingWorkspace] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const stopRef = useRef(false);
  const logId = useRef(2);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const selectedLoop = loops.find((loop) => loop.id === selectedId) ?? loops[0];
  const activeTask = taskId === "new" ? undefined : tasks.find((task) => task.id === taskId);

  const addLog = useCallback((kind: LogLine["kind"], text: string) => {
    setLogs((current) => [...current, { id: logId.current++, time: now(), kind, text }]);
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/tasks").then((r) => r.json()).catch(() => ({ tasks: [] })),
      fetch("/api/models").then((r) => r.json()).catch(() => ({ models: DEFAULT_MODELS })),
      fetch("/api/workspace").then((r) => r.json()).catch(() => ({ workspace: "" })),
    ]).then(([taskData, modelData, workspaceData]) => {
      if (Array.isArray(taskData.tasks)) setTasks(taskData.tasks);
      if (Array.isArray(modelData.models) && modelData.models.length) setModels(modelData.models);
      if (typeof workspaceData.workspace === "string") setWorkspace((current) => current || workspaceData.workspace);
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (taskId === "new") return;
    const task = tasks.find((item) => item.id === taskId);
    if (task?.cwd) setWorkspace(task.cwd);
  }, [tasks, taskId]);

  useEffect(() => {
    try {
      const workspace = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) || "null");
      if (Array.isArray(workspace?.loops) && workspace.loops.length) {
        setLoops(workspace.loops);
        setSelectedId(workspace.loops.some((loop: Loop) => loop.id === workspace.selectedId) ? workspace.selectedId : workspace.loops[0].id);
      }
      if (typeof workspace?.taskId === "string") setTaskId(workspace.taskId);
      if (typeof workspace?.model === "string") setModel(workspace.model);
      if (["minimal", "low", "medium", "high", "xhigh"].includes(workspace?.reasoning)) setReasoning(workspace.reasoning);
      if (typeof workspace?.consoleOpen === "boolean") setConsoleOpen(workspace.consoleOpen);
      if (workspace?.consoleSize && typeof workspace.consoleSize === "object") setConsoleSize(workspace.consoleSize);
      if (typeof workspace?.workspace === "string") setWorkspace(workspace.workspace);
      const library = JSON.parse(window.localStorage.getItem(PROMPT_LIBRARY_STORAGE_KEY) || "[]");
      if (Array.isArray(library)) {
        setSavedPrompts(library);
        setSavedPromptId(library[0]?.id || "");
      }
    } catch {}
    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    const persistWorkspace = () => window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      loops,
      selectedId,
      taskId,
      model,
      reasoning,
      consoleOpen,
      consoleSize,
      workspace,
    }));
    persistWorkspace();
    window.addEventListener("pagehide", persistWorkspace);
    return () => window.removeEventListener("pagehide", persistWorkspace);
  }, [loops, selectedId, taskId, model, reasoning, consoleOpen, consoleSize, workspace, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem(PROMPT_LIBRARY_STORAGE_KEY, JSON.stringify(savedPrompts));
  }, [savedPrompts, storageReady]);

  useEffect(() => {
    if (consoleOpen) consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight, behavior: "smooth" });
  }, [logs, consoleOpen]);

  const primaryReasoning = useMemo(() => models.find((item) => item.id === model)?.reasoning ?? ["low", "medium", "high"], [models, model]);

  function updateLoop(id: string, patch: Partial<Loop>) {
    setLoops((current) => current.map((loop) => (loop.id === id ? { ...loop, ...patch } : loop)));
  }

  function saveCurrentPrompt() {
    if (!selectedLoop) return;
    const existing = savedPrompts.find((item) => item.name.trim().toLowerCase() === selectedLoop.name.trim().toLowerCase());
    const saved: SavedPrompt = {
      ...selectedLoop,
      id: existing?.id || crypto.randomUUID(),
      savedAt: new Date().toISOString(),
    };
    setSavedPrompts((current) => existing
      ? current.map((item) => (item.id === existing.id ? saved : item))
      : [saved, ...current]);
    setSavedPromptId(saved.id);
    addLog("system", `${existing ? "Updated" : "Saved"} prompt “${saved.name}”.`);
  }

  function loadSavedPrompt() {
    const saved = savedPrompts.find((item) => item.id === savedPromptId);
    if (!saved) return;
    const { savedAt: _savedAt, ...loopValues } = saved;
    if (selectedLoop) updateLoop(selectedLoop.id, { ...loopValues, id: selectedLoop.id });
    else {
      const loop = { ...loopValues, id: crypto.randomUUID() };
      setLoops([loop]);
      setSelectedId(loop.id);
    }
    addLog("system", `Loaded prompt “${saved.name}”.`);
  }

  function deleteSavedPrompt() {
    const saved = savedPrompts.find((item) => item.id === savedPromptId);
    if (!saved) return;
    const remaining = savedPrompts.filter((item) => item.id !== saved.id);
    setSavedPrompts(remaining);
    setSavedPromptId(remaining[0]?.id || "");
    addLog("system", `Deleted saved prompt “${saved.name}”.`);
  }

  function selectTask(nextTaskId: string) {
    setTaskId(nextTaskId);
    if (nextTaskId === "new") return;
    const task = tasks.find((item) => item.id === nextTaskId);
    if (!task) return;
    if (task.cwd) setWorkspace(task.cwd);
    if (task.model) {
      setModel(task.model);
      setModels((current) => current.some((item) => item.id === task.model)
        ? current
        : [...current, { id: task.model!, name: task.model!, reasoning: task.reasoning ? [task.reasoning] : ["low", "medium", "high"] }]);
    }
    if (task.reasoning) setReasoning(task.reasoning);
  }

  async function browseWorkspace() {
    if (browsingWorkspace || cliRunning || loopRunning) return;
    setBrowsingWorkspace(true);
    try {
      const response = await fetch("/api/workspace", { method: "POST" });
      const result = await response.json();
      if (result.workspace) {
        setWorkspace(result.workspace);
        addLog("system", `Workspace set to ${result.workspace}`);
      } else if (result.error) addLog("error", result.error);
    } catch {
      addLog("error", "Could not open the workspace browser. Enter the absolute path directly.");
    } finally {
      setBrowsingWorkspace(false);
    }
  }

  function addLoop(type: LoopType) {
    const loop = newLoop(type);
    setLoops((current) => [...current, loop]);
    setSelectedId(loop.id);
  }

  function removeLoop(id: string) {
    setLoops((current) => {
      const next = current.filter((loop) => loop.id !== id);
      if (selectedId === id) setSelectedId(next[0]?.id ?? "");
      return next;
    });
  }

  function stopLoop() {
    stopRef.current = true;
    setLoopRunning(false);
    addLog("system", cliRunning ? "Loop stopped — the current Codex turn will finish." : "Loop stopped.");
  }

  function stopCodex() {
    stopRef.current = true;
    abortRef.current?.abort();
    setCliRunning(false);
    setLoopRunning(false);
    addLog("system", "Codex execution aborted. Loop halted for safety.");
  }

  async function runCodex(prompt: string, sessionId: string | null, options?: { ephemeral?: boolean; runModel?: string; runReasoning?: Reasoning }) {
    setCliRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        prompt,
        taskId: sessionId,
        model: options?.runModel ?? model,
        reasoning: options?.runReasoning ?? reasoning,
        ephemeral: options?.ephemeral ?? false,
        workspace,
      }),
    });
    if (!response.ok || !response.body) throw new Error((await response.text()) || "Could not start Codex");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let output = "";
    let createdTaskId = sessionId;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && event.thread_id) createdTaskId = event.thread_id;
          const assistantText = agentMessageText(event);
          if (assistantText) output += `${assistantText}\n`;
          const visibleEvent = consoleEventText(event);
          if (visibleEvent && !options?.ephemeral) addLog(visibleEvent.kind, visibleEvent.text);
        } catch {}
      }
    }
    setCliRunning(false);
    return { output: output.trim(), taskId: createdTaskId };
  }

  async function evaluate(loop: Loop, output: string) {
    addLog("eval", `Evaluator checking goal with ${loop.evaluatorModel} · ${loop.evaluatorReasoning}`);
    const evaluationPrompt = `You are a strict loop completion evaluator. Determine whether the goal is fully met based only on the latest Codex result.\n\nGOAL:\n${loop.goal}\n\nLATEST RESULT:\n${output.slice(-14000)}\n\nRespond with exactly one token: GOAL_MET if the goal is clearly complete, otherwise CONTINUE.`;
    const result = await runCodex(evaluationPrompt, null, {
      ephemeral: true,
      runModel: loop.evaluatorModel,
      runReasoning: loop.evaluatorReasoning,
    });
    const met = /GOAL_MET/i.test(result.output) && !/CONTINUE/i.test(result.output);
    addLog("eval", met ? "Goal met — conditional loop complete." : "Goal not met — scheduling the next pass.");
    return met;
  }

  async function playLoop() {
    if (loopRunning || cliRunning || !selectedLoop || !selectedLoop.prompt.trim() || !workspace.trim()) return;
    setLoopRunning(true);
    setConsoleOpen(true);
    setIteration(0);
    stopRef.current = false;
    let sessionId = taskId === "new" ? null : taskId;
    addLog("system", `Started “${selectedLoop.name}” · ${selectedLoop.type} loop`);

    try {
      let pass = 0;
      while (!stopRef.current) {
        pass += 1;
        setIteration(pass);
        addLog("input", `[Pass ${pass}] ${selectedLoop.prompt}`);
        const result = await runCodex(selectedLoop.prompt, sessionId);
        if (result.taskId && result.taskId !== sessionId) {
          sessionId = result.taskId;
          setTaskId(result.taskId);
          setTasks((current) => current.some((task) => task.id === result.taskId) ? current : [{ id: result.taskId!, title: selectedLoop.name, updatedAt: new Date().toISOString(), model, reasoning, cwd: workspace }, ...current]);
          addLog("system", `Task attached · ${result.taskId.slice(0, 8)}`);
        }
        if (stopRef.current) break;
        if (selectedLoop.type === "conditional" && (await evaluate(selectedLoop, result.output))) break;
        await new Promise((resolve) => setTimeout(resolve, 850));
      }
    } catch (error) {
      if (!stopRef.current) addLog("error", error instanceof Error ? error.message : "Loop failed");
    } finally {
      abortRef.current = null;
      setCliRunning(false);
      setLoopRunning(false);
    }
  }

  async function runOnce() {
    if (cliRunning || loopRunning || !selectedLoop?.prompt.trim() || !workspace.trim()) return;
    stopRef.current = false;
    setConsoleOpen(true);
    const sessionId = taskId === "new" ? null : taskId;
    addLog("input", `[Single turn] ${selectedLoop.prompt}`);
    try {
      const result = await runCodex(selectedLoop.prompt, sessionId);
      if (result.taskId && result.taskId !== sessionId) {
        setTaskId(result.taskId);
        setTasks((current) => current.some((task) => task.id === result.taskId) ? current : [{ id: result.taskId!, title: selectedLoop.name, updatedAt: new Date().toISOString(), model, reasoning, cwd: workspace }, ...current]);
        addLog("system", `Task attached · ${result.taskId.slice(0, 8)}`);
      }
    } catch (error) {
      if (!stopRef.current) addLog("error", error instanceof Error ? error.message : "Codex execution failed");
    } finally {
      abortRef.current = null;
      setCliRunning(false);
    }
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/looper-type") as LoopType;
    const movingId = event.dataTransfer.getData("application/looper-id");
    if (type === "infinite" || type === "conditional") addLoop(type);
    else if (movingId) {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-loop-id]")?.dataset.loopId;
      if (target && target !== movingId) {
        setLoops((current) => {
          const from = current.findIndex((item) => item.id === movingId);
          const to = current.findIndex((item) => item.id === target);
          const next = [...current];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return next;
        });
      }
    }
  }

  function beginConsoleResize(event: React.PointerEvent, axis: "horizontal" | "vertical" | "both") {
    event.preventDefault();
    const panel = (event.currentTarget as HTMLElement).closest<HTMLElement>(".console-panel");
    if (!panel) return;
    const start = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    document.body.classList.add("is-resizing");
    const onMove = (moveEvent: PointerEvent) => {
      setConsoleSize({
        width: axis === "vertical" ? start.width : Math.max(360, Math.min(window.innerWidth - 24, start.width + (startX - moveEvent.clientX) * 2)),
        height: axis === "horizontal" ? start.height : Math.max(180, Math.min(window.innerHeight - 88, start.height + moveEvent.clientY - startY)),
      });
    };
    const onEnd = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><i /></span><span>Looper</span><em>for Codex</em></div>
        <div className="control-deck">
          <div className="control-group" aria-label="Codex execution controls">
            <span className="control-label">CODEX</span>
            <div className="transport compact"><button className="transport-btn stop" onClick={stopCodex} disabled={!cliRunning} aria-label="Stop Codex execution">■</button><button className="transport-btn play" onClick={runOnce} disabled={cliRunning || loopRunning || !selectedLoop || !workspace.trim()} aria-label="Start one Codex execution">▶</button><span className={`run-status ${cliRunning ? "active codex" : ""}`}><i />{cliRunning ? "EXECUTING" : "IDLE"}</span></div>
          </div>
          <div className="deck-divider" />
          <div className="control-group" aria-label="Loop controls">
            <span className="control-label">LOOP</span>
            <div className="transport compact"><button className="transport-btn stop" onClick={stopLoop} disabled={!loopRunning} aria-label="Stop automatic looping">■</button><button className="transport-btn play" onClick={playLoop} disabled={loopRunning || cliRunning || !selectedLoop || !workspace.trim()} aria-label="Start automatic looping">▶</button><span className={`run-status ${loopRunning ? "active loop" : ""}`}><i />{loopRunning ? `PASS ${iteration}` : "PAUSED"}</span></div>
          </div>
        </div>
        <div className="top-meta"><span className="connection"><i /> CLI CONNECTED</span><button className="icon-button" aria-label="Settings">⌘</button></div>
      </header>

      <div className={`body-grid ${consoleOpen ? "console-visible" : ""}`}>
        <aside className="sidebar">
          <div className="side-heading"><span>LOOP BLOCKS</span><span className="hint">DRAG TO CANVAS</span></div>
          <button className="palette-card infinite" draggable onDragStart={(e) => e.dataTransfer.setData("application/looper-type", "infinite")} onClick={() => addLoop("infinite")}>
            <span className="block-icon">∞</span><span><strong>Infinite loop</strong><small>Repeat a prompt forever</small></span><b>⠿</b>
          </button>
          <button className="palette-card conditional" draggable onDragStart={(e) => e.dataTransfer.setData("application/looper-type", "conditional")} onClick={() => addLoop("conditional")}>
            <span className="block-icon">◇</span><span><strong>Conditional loop</strong><small>Run until a goal is met</small></span><b>⠿</b>
          </button>
          <div className="prompt-library">
            <div className="library-heading"><span>SAVED PROMPTS</span><b>{savedPrompts.length}</b></div>
            <select aria-label="Saved prompts" value={savedPromptId} onChange={(event) => setSavedPromptId(event.target.value)} disabled={!savedPrompts.length}>
              {!savedPrompts.length && <option value="">No saved prompts yet</option>}
              {savedPrompts.map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}
            </select>
            <div className="library-actions"><button onClick={loadSavedPrompt} disabled={!savedPromptId}>Load</button><button className="save-prompt" onClick={saveCurrentPrompt} disabled={!selectedLoop}>Save current</button><button className="delete-prompt" onClick={deleteSavedPrompt} disabled={!savedPromptId} aria-label="Delete saved prompt">×</button></div>
            <small>Uses the selected loop name. Drafts save automatically.</small>
          </div>
          <div className="side-note"><span>HOW IT WORKS</span><p>Drop a block, edit its prompt, choose a Codex task, then press play. Looper re-prompts only after each turn completes.</p></div>
          <div className="shortcut-list"><span><kbd>⌘</kbd><kbd>↵</kbd> Run loop</span><span><kbd>Esc</kbd> Stop</span></div>
        </aside>

        <section className="workspace">
          <div className="config-strip">
            <label className="field task-field"><span>TASK</span><select value={taskId} onChange={(e) => selectTask(e.target.value)}><option value="new">＋ Create a new Codex task</option>{tasks.map((task) => <option value={task.id} key={task.id}>{task.title}{compactAge(task.updatedAt, clock) ? ` · ${compactAge(task.updatedAt, clock)}` : ""}</option>)}</select></label>
            <label className="field workspace-field"><span>WORKSPACE</span><div className="workspace-control"><input value={workspace} onChange={(event) => setWorkspace(event.target.value)} disabled={cliRunning || loopRunning} spellCheck={false} aria-label="Workspace directory" placeholder="Choose a workspace directory"/><button type="button" onClick={browseWorkspace} disabled={browsingWorkspace || cliRunning || loopRunning}>{browsingWorkspace ? "Opening…" : "Browse"}</button></div></label>
            <label className="field"><span>MODEL</span><select value={model} onChange={(e) => setModel(e.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="field reasoning-field"><span>REASONING</span><select value={reasoning} onChange={(e) => setReasoning(e.target.value as Reasoning)}>{primaryReasoning.map((level) => <option key={level}>{level}</option>)}</select></label>
          </div>

          <div className="canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <div className="canvas-head"><div><span className="eyebrow">WORKFLOW</span><h1>Prompt loop</h1></div><div className="canvas-actions"><button onClick={() => addLoop("conditional")}>＋ Add loop</button><button aria-label="More options">•••</button></div></div>
            <div className="flow">
              <div className={`start-node ${activeTask ? "task-active" : ""}`} title={activeTask?.title}><i /><span>{activeTask?.title || "START"}</span>{activeTask?.updatedAt && <em>{compactAge(activeTask.updatedAt, clock)}</em>}</div>
              <div className="flow-line" />
              {loops.map((loop, index) => (
                <div className="flow-segment" key={loop.id}>
                  <article data-loop-id={loop.id} className={`loop-card ${loop.type} ${selectedId === loop.id ? "selected" : ""}`} onClick={() => setSelectedId(loop.id)}>
                    <div className="card-bar" draggable onDragStart={(e) => e.dataTransfer.setData("application/looper-id", loop.id)}>
                      <div className="loop-kind"><span>{loop.type === "infinite" ? "∞" : "◇"}</span><input aria-label="Loop name" value={loop.name} onChange={(e) => updateLoop(loop.id, { name: e.target.value })} /></div>
                      <div className="card-tools"><span className="type-chip">{loop.type}</span><button onClick={(e) => { e.stopPropagation(); removeLoop(loop.id); }} aria-label="Delete loop">×</button><b>⠿</b></div>
                    </div>
                    <div className="card-content">
                      <label><span>PROMPT <em>EDITABLE</em></span><textarea value={loop.prompt} onChange={(e) => updateLoop(loop.id, { prompt: e.target.value })} rows={4} /></label>
                      {loop.type === "conditional" && <>
                        <div className="condition-divider"><span>UNTIL</span></div>
                        <label><span>GOAL / EVALUATOR CRITERIA <em>EDITABLE</em></span><textarea className="goal-input" value={loop.goal} onChange={(e) => updateLoop(loop.id, { goal: e.target.value })} rows={2} /></label>
                        <div className="evaluator-row"><div><span className="eval-mark">E</span><p><strong>Evaluator</strong><small>Checks after each pass</small></p></div><select value={loop.evaluatorModel} onChange={(e) => updateLoop(loop.id, { evaluatorModel: e.target.value })}>{models.map((item) => <option key={item.id}>{item.id}</option>)}</select><select value={loop.evaluatorReasoning} onChange={(e) => updateLoop(loop.id, { evaluatorReasoning: e.target.value as Reasoning })}><option>low</option><option>medium</option><option>high</option></select></div>
                      </>}
                    </div>
                    <div className="card-footer"><span><i /> {loop.type === "infinite" ? "Repeats on completion" : "Evaluator gates next pass"}</span><button onClick={(e) => { e.stopPropagation(); playLoop(); }} disabled={loopRunning || cliRunning || selectedId !== loop.id || !workspace.trim()}>Run this loop ↗</button></div>
                  </article>
                  {index < loops.length - 1 && <div className="flow-line" />}
                </div>
              ))}
              {!loops.length && <button className="drop-empty" onClick={() => addLoop("conditional")}><b>＋</b><span>Drop a loop block here</span><small>or click to add a conditional loop</small></button>}
              <div className="drop-tail"><span>＋</span> DROP ANOTHER LOOP</div>

              <section className={`console-panel ${consoleOpen ? "open" : ""}`} style={{ width: consoleSize.width, height: consoleOpen ? consoleSize.height : undefined }}>
                <div className="resize-handle resize-left" role="separator" aria-label="Resize console width" onPointerDown={(event) => beginConsoleResize(event, "horizontal")} />
                <div className="resize-handle resize-bottom" role="separator" aria-label="Resize console height" onPointerDown={(event) => beginConsoleResize(event, "vertical")} />
                <div className="resize-handle resize-corner" role="separator" aria-label="Resize console width and height" onPointerDown={(event) => beginConsoleResize(event, "both")} />
                <button className="console-tab" onClick={() => setConsoleOpen((value) => !value)}><span><i /> CONSOLE</span><b>{logs.length}</b><em>{consoleOpen ? "⌄" : "⌃"}</em></button>
                <div className="console-toolbar"><div><i /> LIVE OUTPUT <span>{taskId === "new" ? "NO TASK YET" : taskId.slice(0, 8)}</span></div><div><button onClick={() => navigator.clipboard?.writeText(logs.map((line) => `[${line.time}] ${line.text}`).join("\n"))}>COPY</button><button onClick={() => setLogs([])}>CLEAR</button></div></div>
                <div className="console-scroll" ref={consoleRef}>
                  {logs.map((line) => <div className={`log-line ${line.kind}`} key={line.id}><time>{line.time}</time><span className="log-glyph">{line.kind === "input" ? "›" : line.kind === "output" ? "●" : line.kind === "error" ? "!" : line.kind === "eval" ? "◇" : "·"}</span><pre>{line.text}</pre></div>)}
                  {cliRunning && <div className="log-line working"><time>{now()}</time><span className="log-glyph">●</span><pre>Codex is working<span className="dots">...</span></pre></div>}
                </div>
              </section>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
