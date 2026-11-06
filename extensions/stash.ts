import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  type TUI,
  Input,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

// ============================================================================
// Types
// ============================================================================

export interface StashEntry {
  id: string;
  text: string;
  cwd: string;
  timestamp: number;
}

// ============================================================================
// Storage Helpers
// ============================================================================

export function getDefaultStoragePath(): string {
  try {
    const agentDir = getAgentDir();
    return join(agentDir, "stash.json");
  } catch {
    return join(homedir(), ".pi", "agent", "stash.json");
  }
}

export function loadStash(storagePath: string = getDefaultStoragePath()): StashEntry[] {
  if (!existsSync(storagePath)) {
    return [];
  }
  try {
    const raw = readFileSync(storagePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is StashEntry =>
        item &&
        typeof item.id === "string" &&
        typeof item.text === "string" &&
        typeof item.cwd === "string" &&
        typeof item.timestamp === "number"
    );
  } catch {
    return [];
  }
}

export function saveStash(entries: StashEntry[], storagePath: string = getDefaultStoragePath()): void {
  try {
    const dir = dirname(storagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(storagePath, JSON.stringify(entries, null, 2), "utf-8");
  } catch (err) {
    console.error(`[pi-stash] Failed to save stash: ${err}`);
  }
}

export function getStashForCwd(cwd: string, storagePath: string = getDefaultStoragePath()): StashEntry[] {
  const all = loadStash(storagePath);
  return all.filter((entry) => entry.cwd === cwd);
}

export function pushStashEntry(text: string, cwd: string, storagePath: string = getDefaultStoragePath()): StashEntry {
  const entries = loadStash(storagePath);
  const newEntry: StashEntry = {
    id: `stash_${Date.now()}_${randomUUID().slice(0, 8)}`,
    text,
    cwd,
    timestamp: Date.now(),
  };
  // Prepend to top (newest first, LIFO)
  entries.unshift(newEntry);
  saveStash(entries, storagePath);
  return newEntry;
}

export function popStashEntry(cwd: string, storagePath: string = getDefaultStoragePath()): StashEntry | undefined {
  const entries = loadStash(storagePath);
  const index = entries.findIndex((entry) => entry.cwd === cwd);
  if (index === -1) {
    return undefined;
  }
  const [popped] = entries.splice(index, 1);
  saveStash(entries, storagePath);
  return popped;
}

export function deleteStashEntryById(id: string, storagePath: string = getDefaultStoragePath()): boolean {
  const entries = loadStash(storagePath);
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return false;
  }
  entries.splice(index, 1);
  saveStash(entries, storagePath);
  return true;
}

export function clearStashEntries(cwd?: string, storagePath: string = getDefaultStoragePath()): number {
  const entries = loadStash(storagePath);
  if (!cwd) {
    const count = entries.length;
    saveStash([], storagePath);
    return count;
  }
  const remaining = entries.filter((e) => e.cwd !== cwd);
  const removed = entries.length - remaining.length;
  saveStash(remaining, storagePath);
  return removed;
}

// ============================================================================
// Formatting Helpers
// ============================================================================

export function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function sanitizeForSingleLine(text: string): string {
  return text.replace(/\r?\n/g, " ↵ ").trim();
}

// ============================================================================
// Fuzzy Search Overlay Component
// ============================================================================

const MAX_VISIBLE_ROWS = 8;

export class StashSearchOverlay implements Component, Focusable {
  focused = true;

  private tui: TUI;
  private theme: Theme;
  private items: StashEntry[];
  private filteredItems: StashEntry[];
  private selectedIndex = 0;
  private searchInput: Input;
  private onSelectCallback: (entry: StashEntry) => void;
  private onDeleteCallback: (entry: StashEntry) => void;
  private onCancelCallback: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    items: StashEntry[],
    onSelect: (entry: StashEntry) => void,
    onDelete: (entry: StashEntry) => void,
    onCancel: () => void
  ) {
    this.tui = tui;
    this.theme = theme;
    this.items = [...items];
    this.filteredItems = [...items];
    this.onSelectCallback = onSelect;
    this.onDeleteCallback = onDelete;
    this.onCancelCallback = onCancel;

    this.searchInput = new Input({
      prompt: "Search: ",
      placeholder: "Type to filter stashed prompts...",
    });
  }

  private filterItems(query: string): void {
    const trimmed = query.trim();
    if (!trimmed) {
      this.filteredItems = [...this.items];
    } else {
      this.filteredItems = fuzzyFilter(this.items, trimmed, (entry) => entry.text);
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onCancelCallback();
      return;
    }

    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const selected = this.filteredItems[this.selectedIndex];
      if (selected) {
        this.onSelectCallback(selected);
      }
      return;
    }

    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      if (this.filteredItems.length > 0) {
        this.selectedIndex = this.selectedIndex <= 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      if (this.filteredItems.length > 0) {
        this.selectedIndex = this.selectedIndex >= this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
        this.tui.requestRender();
      }
      return;
    }

    // Delete current entry: Delete or Ctrl+D
    if (matchesKey(data, "delete") || matchesKey(data, "ctrl+d")) {
      const selected = this.filteredItems[this.selectedIndex];
      if (selected) {
        this.onDeleteCallback(selected);
        this.items = this.items.filter((item) => item.id !== selected.id);
        this.filterItems(this.searchInput.getValue());
        if (this.items.length === 0) {
          this.onCancelCallback();
        } else {
          this.tui.requestRender();
        }
      }
      return;
    }

    // Forward to search input
    this.searchInput.handleInput(data);
    this.filterItems(this.searchInput.getValue());
    this.tui.requestRender();
  }

  render(termWidth: number): string[] {
    const width = Math.max(48, Math.min(76, termWidth - 4));
    const innerW = width - 2;
    const th = this.theme;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };

    const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");
    const sep = () => th.fg("border", `├${"─".repeat(innerW)}┤`);

    // Top border & title
    const titleText = ` 📦 Stashed Prompts (${this.filteredItems.length}/${this.items.length})`;
    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    lines.push(row(th.bold(th.fg("accent", titleText))));
    lines.push(sep());

    // Search input line
    const searchInputRendered = this.searchInput.render(innerW - 2)[0] || "";
    lines.push(row(` ${searchInputRendered}`));
    lines.push(sep());

    // Item list
    if (this.filteredItems.length === 0) {
      lines.push(row(th.fg("muted", "   No matching stashed prompts")));
    } else {
      const startIndex = Math.max(
        0,
        Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2), this.filteredItems.length - MAX_VISIBLE_ROWS)
      );
      const endIndex = Math.min(startIndex + MAX_VISIBLE_ROWS, this.filteredItems.length);

      for (let i = startIndex; i < endIndex; i++) {
        const item = this.filteredItems[i]!;
        const isSelected = i === this.selectedIndex;
        const prefix = isSelected ? th.fg("accent", " → ") : "   ";
        const num = th.fg("dim", `#${i + 1} `);
        const time = th.fg("muted", ` ${formatRelativeTime(item.timestamp)}`);
        const timeWidth = visibleWidth(time);

        const prefixNumWidth = visibleWidth(prefix) + visibleWidth(num);
        const maxTextWidth = Math.max(10, innerW - prefixNumWidth - timeWidth - 2);

        const singleLine = sanitizeForSingleLine(item.text);
        const truncated = truncateToWidth(singleLine, maxTextWidth, "…");
        const promptDisplay = isSelected ? th.bold(th.fg("accent", truncated)) : th.fg("text", truncated);

        const contentWithoutTime = `${prefix}${num}${promptDisplay}`;
        const contentWidth = visibleWidth(contentWithoutTime);
        const gap = " ".repeat(Math.max(1, innerW - contentWidth - timeWidth - 1));

        lines.push(row(`${contentWithoutTime}${gap}${time}`));
      }
    }

    // Footer with controls
    lines.push(sep());
    const hints = " ↑↓ navigate • enter restore • del delete • esc close";
    lines.push(row(th.fg("dim", hints)));
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

// ============================================================================
// Extension Registration
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Handle Super+Shift+C (Cmd+Shift+C): Stash or Pop
  const handleStash = (ctx: ExtensionContext | ExtensionCommandContext) => {
    if (!ctx.hasUI) return;

    const editorText = ctx.ui.getEditorText() ?? "";

    // 1. If prompt box has text: stash it!
    if (editorText.trim().length > 0) {
      pushStashEntry(editorText, ctx.cwd);
      ctx.ui.setEditorText("");
      const count = getStashForCwd(ctx.cwd).length;
      ctx.ui.notify(`Prompt stashed (${count} in stash)`, "info");
      return;
    }

    // 2. Prompt box is empty: Pop/Restore top item immediately from disk
    const popped = popStashEntry(ctx.cwd);
    if (!popped) {
      ctx.ui.notify("Stash is empty", "warning");
      return;
    }

    ctx.ui.setEditorText(popped.text);
    ctx.ui.notify("Restored stashed prompt", "info");
  };

  // Handle Ctrl+Shift+S: Fuzzy Search Overlay
  const handleFuzzySearch = async (ctx: ExtensionContext | ExtensionCommandContext) => {
    if (!ctx.hasUI) return;

    const items = getStashForCwd(ctx.cwd);
    if (items.length === 0) {
      ctx.ui.notify("Stash is empty", "warning");
      return;
    }

    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        const overlay = new StashSearchOverlay(
          tui,
          theme,
          items,
          (selected) => {
            deleteStashEntryById(selected.id);
            ctx.ui.setEditorText(selected.text);
            ctx.ui.notify("Restored stashed prompt", "info");
            done();
          },
          (deleted) => {
            deleteStashEntryById(deleted.id);
            ctx.ui.notify("Deleted stashed prompt", "info");
          },
          () => {
            done();
          }
        );
        return overlay;
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: Math.max(48, Math.min(76, 80)) },
      }
    );
  };

  // Register Shortcuts
  pi.registerShortcut("super+shift+c", {
    description: "Stash currently typed prompt or pop stashed prompt",
    handler: (ctx) => handleStash(ctx),
  });

  pi.registerShortcut("super+shift+l", {
    description: "Fuzzy search stashed prompts",
    handler: (ctx) => handleFuzzySearch(ctx),
  });

  // Register Command /stash
  pi.registerCommand("stash", {
    description: "Manage stashed prompts (stash, pop, list, clear)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().toLowerCase();
      if (!sub) {
        const text = ctx.ui.getEditorText() ?? "";
        if (text.trim().length > 0) {
          handleStash(ctx);
        } else {
          await handleFuzzySearch(ctx);
        }
        return;
      }

      if (sub === "pop") {
        const popped = popStashEntry(ctx.cwd);
        if (!popped) {
          ctx.ui.notify("Stash is empty", "warning");
        } else {
          ctx.ui.setEditorText(popped.text);
          ctx.ui.notify("Restored stashed prompt", "info");
        }
        return;
      }

      if (sub === "list" || sub === "search") {
        await handleFuzzySearch(ctx);
        return;
      }

      if (sub === "clear") {
        const count = clearStashEntries(ctx.cwd);
        ctx.ui.notify(`Cleared ${count} stashed prompt(s)`, "info");
        return;
      }

      ctx.ui.notify(`Unknown stash subcommand: ${sub}. Use pop, list, search, or clear.`, "error");
    },
  });
}
