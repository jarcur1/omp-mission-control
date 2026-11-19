# Changelog

## Unreleased

- Load `@oh-my-pi/omp-stats` only when opening a trace, so `/mc` installs and starts on compiled OMP 18.22 hosts that remap `pi-utils` to the binary.

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
