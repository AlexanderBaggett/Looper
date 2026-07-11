# Looper

A local web interface for running repeatable prompts against the Codex CLI.

## Start

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Looper uses the Codex CLI bundled with the ChatGPT desktop app by default. Set `CODEX_BIN` if your CLI lives elsewhere.

## Controls

- **Codex controls** run one prompt or abort the active CLI process.
- **Loop controls** start or pause automatic re-prompting. Pausing allows the active Codex turn to finish.
- **Infinite loops** repeat after each completed turn.
- **Conditional loops** call a separate selectable evaluator model after each turn and stop when the editable goal is met.

Looper reads recent local Codex tasks from `$CODEX_HOME/sessions` (or `~/.codex/sessions`) and streams `codex exec --json` events into the in-app console.
