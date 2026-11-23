# pi-bash-tasks

Claude Code's `run_in_background` ported to [pi](https://github.com/earendil-works/pi).

Every `bash` call gets a foreground timeout (`PI_BASH_BG_TIMEOUT`, default 60s). When it fires:

1. The command is **respawned detached** — output streams to `~/.pi/agent/tmp/bgtasks/<id>.log`
2. The tool result is rewritten to `moved to background task <id>`
3. When the process exits, the agent gets a **followUp message** with the output tail — no polling

The model can also background explicitly with `bash_bg_start`, peek with `bash_bg_status`, and stop with `bash_bg_kill`.

## Install

```bash
pi install git:github.com/farizapr/pi-bash-tasks
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/farizapr/pi-bash-tasks"]
}
```

## Tools

| Tool | Use |
|---|---|
| `bash_bg_start` | Start a command in background, returns task id + log path |
| `bash_bg_status` | List tasks / read one task's log tail |
| `bash_bg_kill` | Kill a running task's process group |

## Environment

- `PI_BASH_BG_TIMEOUT` — seconds before a foreground `bash` call moves to background (default: `60`)
