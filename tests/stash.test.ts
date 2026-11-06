import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import defaultExtension, {
  loadStash,
  saveStash,
  pushStashEntry,
  popStashEntry,
  deleteStashEntryById,
  clearStashEntries,
  getStashForCwd,
  formatRelativeTime,
  StashSearchOverlay,
  type StashEntry,
} from "../extensions/stash.ts";

describe("pi-stash storage", () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-stash-test-"));
    testFile = join(tempDir, "stash.json");
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when file does not exist", () => {
    expect(loadStash(testFile)).toEqual([]);
  });

  it("saves and loads stash entries accurately", () => {
    const entries: StashEntry[] = [
      { id: "1", text: "Prompt one", cwd: "/test/dir", timestamp: 1000 },
      { id: "2", text: "Prompt two", cwd: "/test/dir", timestamp: 2000 },
    ];
    saveStash(entries, testFile);
    expect(loadStash(testFile)).toEqual(entries);
  });

  it("pushes entries in LIFO order (newest first)", () => {
    const cwd = "/my/project";
    pushStashEntry("First prompt", cwd, testFile);
    pushStashEntry("Second prompt", cwd, testFile);
    pushStashEntry("Third prompt", cwd, testFile);

    const entries = loadStash(testFile);
    expect(entries.length).toBe(3);
    expect(entries[0].text).toBe("Third prompt");
    expect(entries[1].text).toBe("Second prompt");
    expect(entries[2].text).toBe("First prompt");
  });

  it("pops entries in LIFO order", () => {
    const cwd = "/my/project";
    pushStashEntry("First", cwd, testFile);
    pushStashEntry("Second", cwd, testFile);

    const popped1 = popStashEntry(cwd, testFile);
    expect(popped1?.text).toBe("Second");

    const popped2 = popStashEntry(cwd, testFile);
    expect(popped2?.text).toBe("First");

    const popped3 = popStashEntry(cwd, testFile);
    expect(popped3).toBeUndefined();
  });

  it("isolates stash by cwd", () => {
    pushStashEntry("Project A prompt", "/project-a", testFile);
    pushStashEntry("Project B prompt", "/project-b", testFile);

    const aEntries = getStashForCwd("/project-a", testFile);
    expect(aEntries.length).toBe(1);
    expect(aEntries[0].text).toBe("Project A prompt");

    const poppedA = popStashEntry("/project-a", testFile);
    expect(poppedA?.text).toBe("Project A prompt");

    // Project B is untouched
    const bEntries = getStashForCwd("/project-b", testFile);
    expect(bEntries.length).toBe(1);
    expect(bEntries[0].text).toBe("Project B prompt");
  });

  it("deletes an entry by id", () => {
    const e1 = pushStashEntry("Keep", "/test", testFile);
    const e2 = pushStashEntry("Delete me", "/test", testFile);

    expect(deleteStashEntryById(e2.id, testFile)).toBe(true);
    const remaining = loadStash(testFile);
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(e1.id);
  });

  it("clears entries for a specific cwd", () => {
    pushStashEntry("A1", "/dir-a", testFile);
    pushStashEntry("A2", "/dir-a", testFile);
    pushStashEntry("B1", "/dir-b", testFile);

    const removed = clearStashEntries("/dir-a", testFile);
    expect(removed).toBe(2);

    expect(getStashForCwd("/dir-a", testFile)).toEqual([]);
    expect(getStashForCwd("/dir-b", testFile).length).toBe(1);
  });
});

describe("formatRelativeTime", () => {
  it("formats seconds as just now", () => {
    expect(formatRelativeTime(Date.now() - 5000)).toBe("just now");
  });

  it("formats minutes ago", () => {
    expect(formatRelativeTime(Date.now() - 3 * 60 * 1000)).toBe("3m ago");
  });

  it("formats hours ago", () => {
    expect(formatRelativeTime(Date.now() - 2 * 60 * 60 * 1000)).toBe("2h ago");
  });

  it("formats days ago", () => {
    expect(formatRelativeTime(Date.now() - 5 * 24 * 60 * 60 * 1000)).toBe("5d ago");
  });
});

describe("StashSearchOverlay component", () => {
  const dummyTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;

  const dummyTui = {
    requestRender: () => {},
  } as any;

  it("filters items with fuzzy query and selects", () => {
    const items: StashEntry[] = [
      { id: "1", text: "Refactor auth controller", cwd: "/test", timestamp: Date.now() },
      { id: "2", text: "Fix database index migration", cwd: "/test", timestamp: Date.now() },
      { id: "3", text: "Update documentation in README", cwd: "/test", timestamp: Date.now() },
    ];

    let selectedEntry: StashEntry | null = null;
    let cancelled = false;

    const overlay = new StashSearchOverlay(
      dummyTui,
      dummyTheme,
      items,
      (entry) => {
        selectedEntry = entry;
      },
      () => {},
      () => {
        cancelled = true;
      }
    );

    // Type query "doc"
    overlay.handleInput("d");
    overlay.handleInput("o");
    overlay.handleInput("c");

    // Press enter to select
    overlay.handleInput("\r");

    expect(selectedEntry).toBeDefined();
    expect((selectedEntry as StashEntry | null)?.text).toBe("Update documentation in README");
    expect(cancelled).toBe(false);
  });

  it("navigates with up and down arrows", () => {
    const items: StashEntry[] = [
      { id: "1", text: "Alpha", cwd: "/test", timestamp: Date.now() },
      { id: "2", text: "Beta", cwd: "/test", timestamp: Date.now() },
    ];

    let selectedEntry: StashEntry | null = null;
    const overlay = new StashSearchOverlay(
      dummyTui,
      dummyTheme,
      items,
      (entry) => {
        selectedEntry = entry;
      },
      () => {},
      () => {}
    );

    // Down arrow moves to Beta
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\r");
    expect((selectedEntry as StashEntry | null)?.text).toBe("Beta");
  });

  it("handles escape to cancel", () => {
    let cancelled = false;
    const overlay = new StashSearchOverlay(
      dummyTui,
      dummyTheme,
      [{ id: "1", text: "Foo", cwd: "/test", timestamp: Date.now() }],
      () => {},
      () => {},
      () => {
        cancelled = true;
      }
    );

    overlay.handleInput("\x1b");
    expect(cancelled).toBe(true);
  });

  it("renders lines without crashing", () => {
    const items: StashEntry[] = [
      { id: "1", text: "Multi-line\nprompt\nwith details", cwd: "/test", timestamp: Date.now() },
    ];
    const overlay = new StashSearchOverlay(
      dummyTui,
      dummyTheme,
      items,
      () => {},
      () => {},
      () => {}
    );

    const rendered = overlay.render(80);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.some((line) => line.includes("Multi-line ↵ prompt"))).toBe(true);
  });
});

describe("extension lifecycle & shortcuts", () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-stash-test-"));
    testFile = join(tempDir, "stash.json");
    process.env.PI_CODING_AGENT_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles push, LIFO pop, and toggle re-stashing", async () => {
    const shortcuts = new Map<string, (ctx: any) => Promise<void> | void>();
    const commands = new Map<string, any>();

    const mockPi = {
      registerShortcut: (key: string, opts: any) => {
        shortcuts.set(key, opts.handler);
      },
      registerCommand: (name: string, opts: any) => {
        commands.set(name, opts);
      },
      on: () => () => {},
    } as any;

    defaultExtension(mockPi);

    expect(shortcuts.has("ctrl+alt+s")).toBe(true);
    expect(shortcuts.has("ctrl+shift+s")).toBe(true);
    expect(commands.has("stash")).toBe(true);

    let editorText = "";
    const notifications: string[] = [];

    const mockCtx = {
      hasUI: true,
      mode: "tui",
      cwd: "/workspace/my-repo",
      ui: {
        getEditorText: () => editorText,
        setEditorText: (text: string) => {
          editorText = text;
        },
        notify: (msg: string) => {
          notifications.push(msg);
        },
        custom: async () => {},
      },
    };

    const ctrlS = shortcuts.get("ctrl+alt+s")!;

    // 1. User types prompt A and presses ctrl+alt+s
    editorText = "Prompt A";
    await ctrlS(mockCtx);
    expect(editorText).toBe("");
    expect(notifications[notifications.length - 1]).toContain("Prompt stashed (1 in stash)");

    // 2. User types prompt B and presses ctrl+alt+s
    editorText = "Prompt B";
    await ctrlS(mockCtx);
    expect(editorText).toBe("");
    expect(notifications[notifications.length - 1]).toContain("Prompt stashed (2 in stash)");

    // 3. Prompt box is empty, user presses ctrl+alt+s -> restores Prompt B (LIFO)
    await ctrlS(mockCtx);
    expect(editorText).toBe("Prompt B");
    expect(getStashForCwd("/workspace/my-repo", testFile).map((e) => e.text)).toEqual(["Prompt A"]);

    // 4. Box has text (Prompt B), user presses ctrl+alt+s -> re-stashes Prompt B
    await ctrlS(mockCtx);
    expect(editorText).toBe("");
    expect(notifications[notifications.length - 1]).toContain("Prompt stashed (2 in stash)");
    expect(getStashForCwd("/workspace/my-repo", testFile).map((e) => e.text)).toEqual(["Prompt B", "Prompt A"]);

    // 5. Box is empty, user presses ctrl+alt+s -> restores Prompt B again
    await ctrlS(mockCtx);
    expect(editorText).toBe("Prompt B");
    expect(getStashForCwd("/workspace/my-repo", testFile).map((e) => e.text)).toEqual(["Prompt A"]);

    // 6. User submits Prompt B (prompt box becomes empty)
    editorText = "";

    // 7. Prompt box is empty, user presses ctrl+alt+s -> restores Prompt A (LIFO)
    await ctrlS(mockCtx);
    expect(editorText).toBe("Prompt A");
    expect(getStashForCwd("/workspace/my-repo", testFile)).toEqual([]);

    // 8. Box has text (Prompt A), user presses ctrl+alt+s -> re-stashes Prompt A
    await ctrlS(mockCtx);
    expect(editorText).toBe("");
    expect(notifications[notifications.length - 1]).toContain("Prompt stashed (1 in stash)");
    expect(getStashForCwd("/workspace/my-repo", testFile).map((e) => e.text)).toEqual(["Prompt A"]);

    // 9. Box is empty, user presses ctrl+alt+s -> restores Prompt A again
    await ctrlS(mockCtx);
    expect(editorText).toBe("Prompt A");
    expect(getStashForCwd("/workspace/my-repo", testFile)).toEqual([]);
  });

  it("ensures popped prompt is immediately absent from stash without waiting for submit", async () => {
    const shortcuts = new Map<string, (ctx: any) => Promise<void> | void>();
    const mockPi = {
      registerShortcut: (key: string, opts: any) => {
        shortcuts.set(key, opts.handler);
      },
      registerCommand: () => {},
      on: () => () => {},
    } as any;

    defaultExtension(mockPi);

    let editorText = "foobar";
    const mockCtx = {
      hasUI: true,
      mode: "tui",
      cwd: "/workspace/my-repo",
      ui: {
        getEditorText: () => editorText,
        setEditorText: (text: string) => {
          editorText = text;
        },
        notify: () => {},
        custom: async () => {},
      },
    };

    const ctrlS = shortcuts.get("ctrl+alt+s")!;

    // Stash "foobar"
    await ctrlS(mockCtx);
    expect(editorText).toBe("");
    expect(getStashForCwd("/workspace/my-repo", testFile).length).toBe(1);

    // Press ctrl+s on empty box -> restores "foobar"
    await ctrlS(mockCtx);
    expect(editorText).toBe("foobar");

    // Immediately verify stash is empty — before any prompt submit!
    const remaining = getStashForCwd("/workspace/my-repo", testFile);
    expect(remaining).toEqual([]);
  });
});
