import {
  Box,
  extractPrintableText,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@oh-my-pi/pi-tui";
import {
  cleanText,
  type DashboardAction,
  type LiveSession,
  type SessionStatus,
  type TerminalTarget,
} from "./types.ts";

export interface MissionControlDashboardOptions {
  currentInstanceId: string;
  sessions: LiveSession[];
  onAction: (action: DashboardAction) => void;
  onClose: () => void;
  requestRender: () => void;
  getHeight: () => number;
}

const COMPACT_WIDTH_THRESHOLD = 96;
const MAX_FILTER_LENGTH = 80;

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const INVERSE = "\x1b[7m";

function sanitize(value: string | undefined, max = 240): string {
  if (!value) return "";
  const cleaned = cleanText(value, max);
  if (!cleaned) return "";
  const last = cleaned.charCodeAt(cleaned.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cleaned.slice(0, -1) : cleaned;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fitWidth(text: string, width: number, align: "left" | "right" = "left"): string {
  if (width <= 0) return "";
  const fitted = visibleWidth(text) > width ? truncateToWidth(text, width) : text;
  const padCount = Math.max(0, width - visibleWidth(fitted));
  if (padCount === 0) return fitted;
  const pad = " ".repeat(padCount);
  return align === "right" ? `${pad}${fitted}` : `${fitted}${pad}`;
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "working":
      return `${GREEN}● working${RESET}`;
    case "waiting":
      return `${YELLOW}◐ waiting${RESET}`;
    case "idle":
      return `${DIM}○ idle${RESET}`;
    default:
      return `${DIM}○ ${sanitize(String(status), 16) || "idle"}${RESET}`;
  }
}

function terminalShortName(terminal: TerminalTarget): string {
  switch (terminal.kind) {
    case "windows-terminal":
      return "WT";
    case "herdr":
    case "herdr-core":
      return "herdr";
    case "tmux":
      return "tmux";
    case "wezterm":
      return "wezterm";
    case "kitty":
      return "kitty";
    case "unsupported":
      return "no-focus";
  }
}

function describeTerminal(terminal: TerminalTarget, isCurrent: boolean): string {
  const currentSuffix = isCurrent ? " [current terminal]" : "";
  switch (terminal.kind) {
    case "windows-terminal": {
      const marker = sanitize(terminal.marker, 48);
      return `Windows Terminal${marker ? ` (${marker})` : ""}${currentSuffix}`;
    }
    case "herdr":
      return `Herdr pane ${sanitize(terminal.pane, 48)}${currentSuffix}`;
    case "herdr-core":
      return `Herdr terminal ${sanitize(terminal.terminal, 48)}${currentSuffix}`;
    case "tmux": {
      const pane = sanitize(terminal.pane, 48);
      return `tmux${pane ? ` pane ${pane}` : ""}${currentSuffix}`;
    }
    case "wezterm": {
      const pane = sanitize(terminal.pane, 48);
      return `WezTerm${pane ? ` pane ${pane}` : ""}${currentSuffix}`;
    }
    case "kitty": {
      const win = sanitize(terminal.window, 48);
      return `kitty${win ? ` window ${win}` : ""}${currentSuffix}`;
    }
    case "unsupported": {
      const reason = sanitize(terminal.reason, 80) || "unavailable";
      return `unsupported (${reason})${currentSuffix}`;
    }
  }
}
export class MissionControlDashboard implements Component {
  private readonly options: MissionControlDashboardOptions;
  private sessions: LiveSession[];
  private error: string | undefined;
  private selectedInstanceId: string | null = null;
  private selectionLost = false;
  private lastSelectedIndex = 0;
  private scrollOffset = 0;
  private lastPageStep = 5;
  private filterActive = false;
  private filterQuery = "";
  private disposed = false;

  private cachedLines: readonly string[] | undefined;
  private cachedWidth = -1;
  private cachedHeight = -1;

  constructor(options: MissionControlDashboardOptions) {
    this.options = options;
    this.sessions = [...options.sessions];
    this.initializeSelection();
  }

  private initializeSelection(): void {
    const visible = this.getVisibleSessions();
    if (visible.length === 0) {
      this.selectedInstanceId = null;
      this.lastSelectedIndex = 0;
      return;
    }
    const currentIdx = visible.findIndex(
      (s) => s.instanceId === this.options.currentInstanceId,
    );
    const initialIdx = currentIdx >= 0 ? currentIdx : 0;
    this.selectedInstanceId = visible[initialIdx].instanceId;
    this.lastSelectedIndex = initialIdx;
    this.selectionLost = false;
  }

  update(sessions: LiveSession[], error?: string): void {
    if (this.disposed) return;
    this.sessions = [...sessions];
    const cleanError = sanitize(error, 200);
    this.error = cleanError || undefined;

    const visible = this.getVisibleSessions();
    if (this.selectedInstanceId !== null) {
      const stillExists = this.sessions.some(
        (s) => s.instanceId === this.selectedInstanceId,
      );
      if (!stillExists) {
        // Never auto-snap to another terminal when the active selection vanishes;
        // otherwise a pending Enter/t keystroke could focus/trace the wrong session.
        this.selectedInstanceId = null;
        this.selectionLost = true;
      } else {
        const visibleIdx = visible.findIndex(
          (s) => s.instanceId === this.selectedInstanceId,
        );
        if (visibleIdx >= 0) {
          this.lastSelectedIndex = visibleIdx;
        }
      }
    } else if (!this.selectionLost && visible.length > 0) {
      this.initializeSelection();
    }

    this.invalidate();
    this.options.requestRender();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = -1;
    this.cachedHeight = -1;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private getVisibleSessions(): LiveSession[] {
    if (!this.filterQuery) return this.sessions;
    const needle = this.filterQuery.toLowerCase();
    return this.sessions.filter((session) => {
      const haystack = [
        sanitize(session.project, 120),
        sanitize(session.model, 120),
        sanitize(session.task, 200),
        sanitize(session.status, 24),
        sanitize(session.detail, 120),
        sanitize(session.cwd, 160),
        sanitize(session.instanceId, 64),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  private getSelectedSession(visible = this.getVisibleSessions()): LiveSession | undefined {
    if (this.selectedInstanceId === null) return undefined;
    return visible.find((s) => s.instanceId === this.selectedInstanceId);
  }

  private moveSelection(delta: number): void {
    const visible = this.getVisibleSessions();
    if (visible.length === 0) return;

    const currentIdx =
      this.selectedInstanceId !== null
        ? visible.findIndex((s) => s.instanceId === this.selectedInstanceId)
        : -1;

    let targetIdx: number;
    if (currentIdx === -1) {
      if (delta >= 0) {
        targetIdx = clamp(this.lastSelectedIndex, 0, visible.length - 1);
      } else {
        targetIdx = clamp(this.lastSelectedIndex - 1, 0, visible.length - 1);
      }
    } else {
      targetIdx = clamp(currentIdx + delta, 0, visible.length - 1);
    }

    this.selectedInstanceId = visible[targetIdx].instanceId;
    this.lastSelectedIndex = targetIdx;
    this.selectionLost = false;
    this.invalidate();
    this.options.requestRender();
  }

  private moveToEdge(edge: "start" | "end"): void {
    const visible = this.getVisibleSessions();
    if (visible.length === 0) return;

    const targetIdx = edge === "start" ? 0 : visible.length - 1;
    this.selectedInstanceId = visible[targetIdx].instanceId;
    this.lastSelectedIndex = targetIdx;
    this.selectionLost = false;
    this.invalidate();
    this.options.requestRender();
  }

  handleInput(data: string): void {
    if (this.disposed) return;

    if (matchesKey(data, "ctrl+c")) {
      this.options.onClose();
      return;
    }

    if (this.filterActive) {
      if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
        this.filterActive = false;
        this.filterQuery = "";
        this.scrollOffset = 0;
        if (this.selectedInstanceId === null && !this.selectionLost) {
          this.initializeSelection();
        }
        this.invalidate();
        this.options.requestRender();
        return;
      }

      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        this.filterActive = false;
        this.invalidate();
        this.options.requestRender();
        return;
      }

      if (matchesKey(data, "backspace")) {
        if (this.filterQuery.length > 0) {
          const chars = Array.from(this.filterQuery);
          chars.pop();
          this.filterQuery = chars.join("");
        } else {
          this.filterActive = false;
        }
        this.scrollOffset = 0;
        this.invalidate();
        this.options.requestRender();
        return;
      }

      if (matchesKey(data, "up")) {
        this.moveSelection(-1);
        return;
      }
      if (matchesKey(data, "down")) {
        this.moveSelection(1);
        return;
      }
      if (matchesKey(data, "pageUp")) {
        this.moveSelection(-this.lastPageStep);
        return;
      }
      if (matchesKey(data, "pageDown")) {
        this.moveSelection(this.lastPageStep);
        return;
      }
      if (matchesKey(data, "home")) {
        this.moveToEdge("start");
        return;
      }
      if (matchesKey(data, "end")) {
        this.moveToEdge("end");
        return;
      }

      const printable = extractPrintableText(data);
      if (printable !== undefined && printable.length > 0) {
        const cleanChunk = sanitize(printable, MAX_FILTER_LENGTH);
        if (cleanChunk) {
          this.filterQuery = `${this.filterQuery}${cleanChunk}`.slice(0, MAX_FILTER_LENGTH);
          this.scrollOffset = 0;
          this.invalidate();
          this.options.requestRender();
        }
      }
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "esc") || matchesKey(data, "q")) {
      this.options.onClose();
      return;
    }

    if (matchesKey(data, "/")) {
      this.filterActive = true;
      this.invalidate();
      this.options.requestRender();
      return;
    }

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.moveSelection(-this.lastPageStep);
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.moveSelection(this.lastPageStep);
      return;
    }
    if (matchesKey(data, "home")) {
      this.moveToEdge("start");
      return;
    }
    if (matchesKey(data, "end")) {
      this.moveToEdge("end");
      return;
    }

    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const selected = this.getSelectedSession();
      if (!selected) return;
      this.options.onAction({ kind: "focus", instanceId: selected.instanceId });
      return;
    }

    if (matchesKey(data, "t")) {
      const selected = this.getSelectedSession();
      if (!selected) return;
      this.options.onAction({ kind: "trace", instanceId: selected.instanceId });
    }
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.floor(width);
    const rawHeight = this.options.getHeight();
    const safeHeight = Number.isFinite(rawHeight) ? Math.floor(rawHeight) : 24;

    if (safeWidth <= 0 || safeHeight <= 0) {
      return [];
    }

    if (
      this.cachedLines !== undefined &&
      this.cachedWidth === safeWidth &&
      this.cachedHeight === safeHeight
    ) {
      return this.cachedLines;
    }

    // Reserve the panel chrome before laying out rows so the border never clips content.
    const framed = safeWidth >= 5 && safeHeight >= 4;
    const paddingY = framed && safeHeight >= 10 ? 1 : 0;
    const contentWidth = framed ? safeWidth - 4 : safeWidth;
    const contentHeight = framed ? safeHeight - 2 - paddingY * 2 : safeHeight;
    const content = this.buildRenderLines(contentWidth, contentHeight).map((line) => {
      const truncated = truncateToWidth(line, contentWidth);
      return truncated.includes("\x1b[") && !truncated.endsWith(RESET)
        ? `${truncated}${RESET}`
        : truncated;
    });
    let lines: readonly string[] = content;
    if (framed) {
      const panel = new Box(1, paddingY, undefined, {
        chars: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
        color: text => `${CYAN}${text}${RESET}`,
      });
      panel.setIgnoreTight(true);
      panel.addChild({ render: () => content });
      // Box pads every interior row to the full width, hiding the conversation underneath.
      lines = panel.render(safeWidth);
    }
    this.cachedLines = lines;
    this.cachedWidth = safeWidth;
    this.cachedHeight = safeHeight;
    return lines;
  }

  private buildRenderLines(width: number, height: number): string[] {
    const headerLines = this.renderHeader(width);
    const detailLines = this.renderDetails(width, height);
    const footerLines = height >= 4 ? [this.renderFooter(width)] : [];

    // Ensure the list area gets priority if terminal height is very small.
    let details = detailLines;
    let footer = footerLines;
    const minListRows = this.sessions.length === 0 ? 1 : 2;
    while (
      details.length > 0 &&
      headerLines.length + details.length + footer.length + minListRows > height
    ) {
      details = details.slice(1);
    }
    if (
      footer.length > 0 &&
      headerLines.length + details.length + footer.length + 1 > height
    ) {
      footer = [];
    }

    const listBudget = Math.max(
      0,
      height - headerLines.length - details.length - footer.length,
    );
    const listLines = this.renderListArea(width, listBudget);

    const output = [...headerLines, ...listLines, ...details, ...footer];
    return output.slice(0, height);
  }

  private renderHeader(width: number): string[] {
    const total = this.sessions.length;
    let working = 0;
    let waiting = 0;
    let idle = 0;
    for (const s of this.sessions) {
      if (s.status === "working") working++;
      else if (s.status === "waiting") waiting++;
      else idle++;
    }

    const counts = `${total} live (${working} working, ${waiting} waiting, ${idle} idle)`;
    const title = `${BOLD}${CYAN}Mission Control${RESET}  ${counts}`;
    const lines = [title];

    if (this.filterActive || this.filterQuery.length > 0) {
      const visibleCount = this.getVisibleSessions().length;
      const cursor = this.filterActive ? `${INVERSE} ${RESET}` : "";
      const queryText = sanitize(this.filterQuery, MAX_FILTER_LENGTH);
      lines.push(
        `${CYAN}Filter:${RESET} ${queryText}${cursor} ${DIM}(${visibleCount}/${total} shown${this.filterActive ? "" : ", / edit, Esc clear"})${RESET}`,
      );
    }

    if (this.error) {
      lines.push(`${RED}! Refresh error: ${this.error}${RESET}`);
    }

    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderListArea(width: number, budget: number): string[] {
    if (budget <= 0) return [];

    const visible = this.getVisibleSessions();
    if (this.sessions.length === 0) {
      const lines = [
        `${DIM}No live OMP sessions found.${RESET}`,
        `${DIM}Start another interactive omp session to monitor or focus it here.${RESET}`,
      ];
      return lines.slice(0, budget);
    }

    if (visible.length === 0) {
      return [
        `${DIM}No sessions match filter "${sanitize(this.filterQuery, 40)}". Press Esc to clear.${RESET}`,
      ].slice(0, budget);
    }

    const isCompact = width < COMPACT_WIDTH_THRESHOLD;
    if (!isCompact && budget >= 2) {
      return this.renderTable(visible, width, budget);
    }
    return this.renderCards(visible, width, budget);
  }

  private computeWindow(
    visible: LiveSession[],
    capacityItems: number,
  ): { start: number; end: number; selectedIdx: number } {
    const cap = Math.max(1, capacityItems);
    this.lastPageStep = cap;

    const selectedIdx =
      this.selectedInstanceId !== null
        ? visible.findIndex((s) => s.instanceId === this.selectedInstanceId)
        : -1;

    const maxStart = Math.max(0, visible.length - cap);
    let start = clamp(this.scrollOffset, 0, maxStart);

    if (selectedIdx >= 0) {
      if (selectedIdx < start) {
        start = selectedIdx;
      } else if (selectedIdx >= start + cap) {
        start = selectedIdx - cap + 1;
      }
      start = clamp(start, 0, maxStart);
    }

    this.scrollOffset = start;
    const end = Math.min(visible.length, start + cap);
    return { start, end, selectedIdx };
  }

  private renderTable(visible: LiveSession[], width: number, budget: number): string[] {
    // 1 row for column header, optional 1 row for scroll status if overflowed
    const headerRowCount = 1;
    let bodyBudget = Math.max(1, budget - headerRowCount);
    let needScrollLine = visible.length > bodyBudget && budget >= 3;
    if (needScrollLine) {
      bodyBudget = Math.max(1, budget - headerRowCount - 1);
    }

    const { start, end, selectedIdx } = this.computeWindow(visible, bodyBudget);

    const statusW = 9;
    const projectW = width >= 116 ? 22 : 18;
    const modelW = width >= 116 ? 24 : 18;
    const flagsW = width >= 116 ? 22 : 19;
    // marker(2) + status(9) + gap(2) + project + gap(2) + model + gap(2) + task + gap(2) + flags
    const fixedW = 2 + statusW + 2 + projectW + 2 + modelW + 2 + 2 + flagsW;
    const taskW = Math.max(12, width - fixedW);

    const colHeader =
      "  " +
      fitWidth("Status", statusW) +
      "  " +
      fitWidth("Project", projectW) +
      "  " +
      fitWidth("Model", modelW) +
      "  " +
      fitWidth("Task", taskW) +
      "  " +
      fitWidth("Terminal / Trace", flagsW);

    const lines: string[] = [`${DIM}${colHeader}${RESET}`];

    for (let i = start; i < end; i++) {
      const s = visible[i];
      const isSelected = i === selectedIdx;
      const isCurrent = s.instanceId === this.options.currentInstanceId;
      const marker = isSelected ? `${CYAN}${BOLD}> ${RESET}` : "  ";
      const projectRaw = sanitize(s.project, 120) || "(unknown)";
      const projectText = isCurrent ? `${projectRaw} [current]` : projectRaw;
      const modelText = sanitize(s.model, 120) || "(no model)";
      const taskText = sanitize(s.task, 200) || "(no active task)";

      const termTag = isCurrent ? "current" : terminalShortName(s.terminal);
      const traceTag = s.sessionFile ? "trace" : "no-trace";
      const flagsText = `${termTag} · ${traceTag}`;

      const row =
        marker +
        fitWidth(statusLabel(s.status), statusW) +
        "  " +
        fitWidth(isSelected ? `${BOLD}${projectText}${RESET}` : projectText, projectW) +
        "  " +
        fitWidth(modelText, modelW) +
        "  " +
        fitWidth(taskText, taskW) +
        "  " +
        fitWidth(`${DIM}${flagsText}${RESET}`, flagsW);

      lines.push(row);
    }

    if (needScrollLine) {
      const above = start;
      const below = visible.length - end;
      lines.push(
        `${DIM}Showing ${start + 1}-${end} of ${visible.length}${above > 0 ? ` · ↑ ${above} above` : ""}${below > 0 ? ` · ↓ ${below} below` : ""}${RESET}`,
      );
    }

    return lines;
  }

  private renderCards(visible: LiveSession[], width: number, budget: number): string[] {
    // Use 2-line cards when >= 2 rows available; fall back to 1-line compact rows if budget === 1.
    if (budget < 2) {
      const { start, end, selectedIdx } = this.computeWindow(visible, 1);
      const lines: string[] = [];
      for (let i = start; i < end; i++) {
        lines.push(this.renderSingleLineCompact(visible[i], i === selectedIdx, width));
      }
      return lines;
    }

    const rowsPerCard = 2;
    let maxCards = Math.floor(budget / rowsPerCard);
    const hasScrollLine = visible.length > maxCards && budget >= rowsPerCard + 1;
    if (hasScrollLine) {
      maxCards = Math.max(1, Math.floor((budget - 1) / rowsPerCard));
    }

    const { start, end, selectedIdx } = this.computeWindow(visible, maxCards);
    const lines: string[] = [];

    for (let i = start; i < end; i++) {
      const s = visible[i];
      const isSelected = i === selectedIdx;
      const isCurrent = s.instanceId === this.options.currentInstanceId;

      const marker = isSelected ? `${CYAN}${BOLD}> ${RESET}` : "  ";
      const status = statusLabel(s.status);
      const prefix = `${marker}${status}  `;
      const prefixW = visibleWidth(prefix);

      const projectRaw = sanitize(s.project, 120) || "(unknown)";
      const currentBadge = isCurrent ? " [current]" : "";
      const modelRaw = sanitize(s.model, 120) || "(no model)";

      const remainingW = Math.max(8, width - prefixW);
      const separator = " · ";
      const minModelW = Math.min(18, Math.floor(remainingW * 0.4));
      const desiredProjectW = visibleWidth(projectRaw) + visibleWidth(currentBadge);
      const projectBudget = clamp(
        desiredProjectW,
        Math.min(10, remainingW),
        Math.max(4, remainingW - minModelW - separator.length),
      );
      const modelBudget = Math.max(4, remainingW - projectBudget - separator.length);

      const fittedProject =
        visibleWidth(`${projectRaw}${currentBadge}`) > projectBudget
          ? `${truncateToWidth(projectRaw, Math.max(4, projectBudget - visibleWidth(currentBadge)))}${currentBadge}`
          : `${projectRaw}${currentBadge}`;
      const fittedModel = truncateToWidth(modelRaw, modelBudget);
      const projectStyled = isSelected ? `${BOLD}${fittedProject}${RESET}` : fittedProject;
      const cardLine1 = `${prefix}${projectStyled}${DIM}${separator}${RESET}${fittedModel}`;

      const taskRaw = sanitize(s.task, 200) || "(no active task)";
      const flags: string[] = [];
      if (s.terminal.kind === "unsupported") flags.push("no-focus");
      if (!s.sessionFile) flags.push("no-trace");
      const flagSuffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
      const indent = "    ";
      const taskAvail = Math.max(8, width - indent.length);
      let cardLine2: string;
      if (flagSuffix && taskAvail > flagSuffix.length + 16) {
        const taskPart = truncateToWidth(taskRaw, taskAvail - flagSuffix.length);
        cardLine2 = `${indent}${taskPart}${DIM}${flagSuffix}${RESET}`;
      } else {
        cardLine2 = `${indent}${truncateToWidth(taskRaw, taskAvail)}`;
      }

      lines.push(cardLine1, cardLine2);
    }

    if (hasScrollLine) {
      const above = start;
      const below = visible.length - end;
      lines.push(
        `${DIM}Showing ${start + 1}-${end} of ${visible.length}${above > 0 ? ` · ↑ ${above} above` : ""}${below > 0 ? ` · ↓ ${below} below` : ""}${RESET}`,
      );
    }

    return lines;
  }

  private renderSingleLineCompact(
    session: LiveSession,
    isSelected: boolean,
    width: number,
  ): string {
    const isCurrent = session.instanceId === this.options.currentInstanceId;
    const marker = isSelected ? `${CYAN}${BOLD}> ${RESET}` : "  ";
    const project = sanitize(session.project, 60) || "(unknown)";
    const model = sanitize(session.model, 60) || "(no model)";
    const task = sanitize(session.task, 120) || "(no active task)";
    const tag = isCurrent ? " [current]" : "";
    return truncateToWidth(
      `${marker}${statusLabel(session.status)} ${project}${tag} · ${model} · ${task}`,
      width,
    );
  }

  private renderDetails(width: number, height: number): string[] {
    if (this.sessions.length === 0 || height < 6) {
      return [];
    }

    const visible = this.getVisibleSessions();
    const selected = this.getSelectedSession(visible);
    const divider = `${DIM}${"─".repeat(Math.max(1, width))}${RESET}`;

    if (!selected) {
      if (this.selectionLost) {
        const lines = [
          divider,
          `${YELLOW}No active selection — previously selected session is no longer live.${RESET}`,
          `${DIM}Use ↑/↓ or j/k to select another session before focusing or tracing.${RESET}`,
        ];
        return height >= 10 ? lines : lines.slice(1);
      }
      return [];
    }

    const isCurrent = selected.instanceId === this.options.currentInstanceId;
    const project = sanitize(selected.project, 120) || "(unknown)";
    const model = sanitize(selected.model, 120) || "(no model)";
    const cwd = sanitize(selected.cwd, 180) || "(unknown)";
    const detail = sanitize(selected.detail, 180);
    const focusInfo = describeTerminal(selected.terminal, isCurrent);
    const traceFile = sanitize(selected.sessionFile, 96);
    const traceInfo = traceFile ? `available (${traceFile})` : "unavailable (no session file)";

    if (height >= 15) {
      return [
        divider,
        `${BOLD}Selected:${RESET} ${project} (${selected.status})${isCurrent ? ` ${CYAN}[current terminal]${RESET}` : ""} · ${DIM}Model:${RESET} ${model}`,
        `${DIM}CWD:${RESET} ${cwd}${detail ? ` · ${DIM}Detail:${RESET} ${detail}` : ""}`,
        `${DIM}Focus:${RESET} ${focusInfo}`,
        `${DIM}Trace:${RESET} ${traceInfo}`,
      ];
    }

    if (height >= 9) {
      return [
        divider,
        `${DIM}CWD:${RESET} ${cwd}${detail ? ` · ${DIM}Detail:${RESET} ${detail}` : ""}`,
        `${DIM}Focus:${RESET} ${focusInfo}`,
        `${DIM}Trace:${RESET} ${traceInfo}`,
      ];
    }

    return [
      `${DIM}CWD:${RESET} ${cwd} · ${DIM}Focus:${RESET} ${focusInfo} · ${DIM}Trace:${RESET} ${traceInfo}`,
    ];
  }

  private renderFooter(width: number): string {
    const text = this.filterActive
      ? `${DIM}Type to filter · Enter apply · Esc clear · ↑/↓ move${RESET}`
      : `${DIM}↑/↓ or j/k move · PgUp/PgDn/Home/End · Enter focus · t trace · / filter · Esc/q close${RESET}`;
    return truncateToWidth(text, width);
  }
}
