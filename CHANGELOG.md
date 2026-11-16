# Changelog

## Unreleased

- Wrap Mission Control in a bordered, padded panel that masks the conversation underneath and stays within the terminal dimensions.

## 0.1.0

- Add `/mc`, a live OMP terminal dashboard shared across project directories and profiles.
- Show project, model, current task, and working/idle/waiting state.
- Add keyboard filtering and stable selection across live refreshes.
- Add terminal navigation for Windows Terminal, tmux, WezTerm, and Kitty.
- Add Open trace using OMP's existing session-specific trace dashboard.
- Keep presence local; exclude subagents, expired records, and dead processes.
