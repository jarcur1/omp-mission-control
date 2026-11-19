# Changelog

## Unreleased

- Detect herdr-core terminals from `$HC_TERMINAL_ID` and focus them with `herdr-app do pane.focus` (then `agent.focus` when there is no pane), while keeping the older `herdr` multiplexer path.

## 0.2.0

- Wrap Mission Control in a bordered, padded panel that masks the conversation underneath and stays within the terminal dimensions.
- Show OMP's scheduled quota retry countdown in live session details without starting a separate retry loop.
- Add optional Herdr pane detection and focus alongside the existing terminal backends.

## 0.1.0

- Add `/mc`, a live OMP terminal dashboard shared across project directories and profiles.
- Show project, model, current task, and working/idle/waiting state.
- Add keyboard filtering and stable selection across live refreshes.
- Add terminal navigation for Windows Terminal, tmux, WezTerm, and Kitty.
- Add Open trace using OMP's existing session-specific trace dashboard.
- Keep presence local; exclude subagents, expired records, and dead processes.
