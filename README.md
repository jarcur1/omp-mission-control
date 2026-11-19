# Mission Control for OMP

A live session switchboard for [Oh My Pi](https://github.com/can1357/oh-my-pi), opened with `/mc`.

Mission Control answers **what is running now, and where?** OMP's `/resume` finds saved conversations; Mission Control helps navigate work already happening in other terminals.

## What it does

- Shows live OMP terminals **across all project folders**, not just the current directory.
- Displays project, model, current task, and **working / idle / waiting** status.
- Shows the scheduled retry countdown when OMP is waiting on a usage limit.
- Focuses the selected terminal without resuming its conversation in a second process.
- Offers **Open trace** for the selected session using OMP's existing `/trace` dashboard.
- Refreshes every two seconds; removes closed sessions and excludes dead/stale presence records.
- Supports keyboard navigation, filtering, scrolling, and compact terminal layouts inside a bordered, padded panel.

No context/spending charts, token accounting, or parallel analytics UI. Use **Open trace** for deeper inspection. Opening `/mc` makes no model requests.

## Requirements

- OMP **18.20.0 or later**.
- An interactive OMP terminal. RPC, print, and task subagents are not separate terminal rows.
- A supported terminal backend for cross-terminal focus (see below). Status and trace remain available without a focus backend.

## Install

```sh
omp plugin install github:jarcur1/omp-mission-control
```

Then start OMP and run:

```text
/mc
```

**Load the plugin in every terminal you want to monitor.** Installation is global, but an already-running OMP process must run `/reload-plugins` or restart before it can report live state. Sessions launched with `--no-extensions` also need an explicit extension path. Mission Control does not scan saved conversations and pretend they are running.

Named OMP profiles have separate plugin installations. Install in each profile you use; their live presence shares the same machine-wide, user-local registry.

### Local development

```sh
git clone https://github.com/jarcur1/omp-mission-control.git
cd omp-mission-control
bun install
omp plugin link .
```

Reload plugins or restart existing terminals. Alternatively, load only this extension for one launch:

```sh
omp --no-extensions --extension ./index.ts
```

To uninstall:

```sh
omp plugin uninstall omp-mission-control
```

## Controls

| Key | Action |
| --- | --- |
| `↑` / `↓`, `k` / `j` | Select a session |
| `Page Up` / `Page Down`, `Home` / `End` | Navigate longer lists |
| `Enter` | Focus selected terminal; selecting the current terminal just closes the dashboard |
| `t` | **Open trace** for the selected session |
| `/` | Filter by project, model, task, status, or directory |
| `Enter` while filtering | Apply filter |
| `Esc` | Clear filter, or close dashboard |
| `q` | Close dashboard |

Selection follows terminal identity across refreshes. If a selected terminal disappears, navigation is required before an action can target another terminal. Actions recheck that the destination is still live and has not switched sessions.

## Status meanings

- **Working:** the agent is active, a tool is executing, background jobs remain, or automatic compaction is running.
- **Waiting:** a tool approval, `ask` question, or plan review needs an answer. Parallel work cannot hide an open question.
- **Idle:** ready for input, with no tracked work or user-facing wait.

The task comes from the latest prompt; resumed sessions initially use their saved title or most recent user message. Selected details show the active tool's intent and full project directory. Custom extensions' private dialogs may not emit the lifecycle events used to identify waiting.

## Quota retry countdown

If OMP schedules a delayed retry after hitting a usage limit, select the terminal in `/mc` to see **Quota retry in …** in its details. It remains **Working** unless it needs your input. The countdown is OMP's scheduled retry time, not a guarantee that quota will be available then.

To let OMP wait beyond its normal retry delay cap when the provider supplies a quota reset time, enable **Wait For Usage Reset** in `/settings` → **Model** → **Retry & Fallback** (`retry.waitForUsageReset`). OMP retries eligible turns in the same session. Leave the terminal open; Mission Control does not start or resume closed sessions.

## Terminal navigation

| Backend | Behavior / requirement |
| --- | --- |
| Windows Terminal | Selects the matching tab/pane and foregrounds its window through Windows UI Automation. PowerShell 5.1 is used for the bundled helper. Application-controlled tab titles must be enabled. |
| Herdr | Selects the OMP pane in its local Herdr session. Requires Herdr's OMP integration and an attached Herdr client to see the switch. Does not foreground a separate OS window. |
| tmux | Selects the destination pane/window and switches its sole attached client. Ambiguous or unattached clients are rejected. Does not foreground an OS terminal window. |
| WezTerm | Activates the destination pane using its own `WEZTERM_UNIX_SOCKET`; requires the local CLI and a known socket. |
| Kitty | Focuses the destination window using `KITTY_LISTEN_ON`; Kitty remote control must already be enabled. |
| Other terminals | Status and Open trace work; cross-terminal focus reports unsupported. |

On Windows, Mission Control maintains an identifying `[MC:…]` terminal-title marker alongside project and status. Do not manually rename the tab or suppress application titles. Windows may refuse foreground activation; failures are shown rather than opening an unrelated terminal or sending keystrokes to it. The plugin does not change terminal settings or grant permissions.

Herdr is optional. To use it, [install Herdr](https://herdr.dev/docs/install/), run `herdr integration install omp`, then start OMP with Mission Control loaded inside Herdr panes. `/mc` detects those panes automatically. If you open `/mc` outside Herdr, `herdr` must be on your `PATH` to focus a Herdr pane. Sessions outside Herdr keep using their existing terminal backends.

## Open trace

Select a row and press `t`. Mission Control opens the same session-file route used by OMP's built-in `/trace`, in your default browser. It never submits `/trace` as a model prompt, overwrites another terminal's draft, switches the current conversation, or copies analytics into the dashboard.

An unsaved/ephemeral session has no trace; send a message in a normal persistent session first. The native stats server reuses a compatible dashboard on its standard port when available. If that port is occupied by another application, separate OMP runtime copies can create separate fallback dashboard servers; Mission Control follows OMP's server behavior.

OMP's trace dashboard enforces its own sessions-directory boundary. Custom `--session-dir` locations, or a session outside the dashboard's active profile root, can be rejected by OMP even though their terminal is visible in Mission Control. Mission Control does not bypass that boundary.

## Local data and scope

Presence is stored in `~/.omp/mission-control`, shared by projects and profiles for the current OS user. Optional `OMP_MC_DIR` overrides this directory; set it identically in every terminal that should see each other. Separate machines, OS users, and Windows/WSL environments are separate registries.

Records contain PID, session ID/file path, project directory, model, task preview, status, timestamps, and terminal identity. **Task previews may contain private prompt text.** There is no Mission Control network service or telemetry. On POSIX, the directory/files are created with private permissions; Windows access follows your user-profile ACLs. Open trace launches OMP's local dashboard, which serves OMP's existing trace data.

Clean shutdown removes a terminal's record. A crash leaves a small stale file, ignored after twelve seconds or once its PID is dead; foreign/stale files are not deleted automatically.

## Development checks

```sh
bun run typecheck
bun test
```
