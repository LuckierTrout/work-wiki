/**
 * Story 1.3 / FR-8 — last mode and left-column collapse survive a reload.
 *
 * These run in the `node` environment, so `window` is stubbed per test. What
 * matters is not that the happy path works but that every unhappy one degrades
 * to the default instead of throwing: a private-mode browser, a quota error, an
 * SSR render, and a stored value from a build that no longer has that mode all
 * reach these functions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKBENCH_COLLAPSED_KEY,
  WORKBENCH_MODE_KEY,
  readStoredCollapsed,
  readStoredMode,
  writeStoredCollapsed,
  writeStoredMode,
} from "../workbench-state";

type Store = Record<string, string>;

const realWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function stubWindow(localStorage: unknown): void {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage },
    configurable: true,
    writable: true,
  });
}

function memoryStorage(initial: Store = {}) {
  const store: Store = { ...initial };
  return {
    store,
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
}

function removeWindow(): void {
  Object.defineProperty(globalThis, "window", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (realWindow) Object.defineProperty(globalThis, "window", realWindow);
  else removeWindow();
  vi.restoreAllMocks();
});

describe("storage keys", () => {
  it("keep the yopedia runtime prefix (AD-7: the rebrand is display-only)", () => {
    expect(WORKBENCH_MODE_KEY).toBe("yopedia_workbench_mode");
    expect(WORKBENCH_COLLAPSED_KEY).toBe("yopedia_workbench_left_collapsed");
    for (const key of [WORKBENCH_MODE_KEY, WORKBENCH_COLLAPSED_KEY]) {
      expect(key.startsWith("yopedia_")).toBe(true);
    }
  });
});

describe("readStoredMode", () => {
  it("defaults to wiki when nothing is stored", () => {
    stubWindow(memoryStorage());
    expect(readStoredMode()).toBe("wiki");
  });

  it("restores the last mode", () => {
    stubWindow(memoryStorage({ [WORKBENCH_MODE_KEY]: "lint" }));
    expect(readStoredMode()).toBe("lint");
  });

  it("ignores a value that is not a mode id", () => {
    for (const corrupt of ["chatt", "", "[1,2]", "null"]) {
      stubWindow(memoryStorage({ [WORKBENCH_MODE_KEY]: corrupt }));
      expect(readStoredMode()).toBe("wiki");
    }
  });

  it("degrades to the default when the accessor throws", () => {
    stubWindow({
      getItem: () => {
        throw new Error("SecurityError: localStorage is disabled");
      },
      setItem: () => {
        throw new Error("SecurityError: localStorage is disabled");
      },
    });
    expect(readStoredMode()).toBe("wiki");
  });

  it("returns the default with no window (server render)", () => {
    removeWindow();
    expect(readStoredMode()).toBe("wiki");
  });
});

describe("writeStoredMode", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    stubWindow(storage);
    writeStoredMode("todos");
    expect(storage.store[WORKBENCH_MODE_KEY]).toBe("todos");
    expect(readStoredMode()).toBe("todos");
  });

  it("is a silent no-op when storage throws", () => {
    stubWindow({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => writeStoredMode("graph")).not.toThrow();
  });

  it("is a no-op with no window", () => {
    removeWindow();
    expect(() => writeStoredMode("graph")).not.toThrow();
  });
});

describe("left-column collapse", () => {
  it('is collapsed only for the stored "1"', () => {
    stubWindow(memoryStorage({ [WORKBENCH_COLLAPSED_KEY]: "1" }));
    expect(readStoredCollapsed()).toBe(true);
    for (const other of ["0", "", "true", "yes"]) {
      stubWindow(memoryStorage({ [WORKBENCH_COLLAPSED_KEY]: other }));
      expect(readStoredCollapsed()).toBe(false);
    }
  });

  it("defaults to expanded when unset, unreadable, or server-rendered", () => {
    stubWindow(memoryStorage());
    expect(readStoredCollapsed()).toBe(false);
    stubWindow({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
    });
    expect(readStoredCollapsed()).toBe(false);
    removeWindow();
    expect(readStoredCollapsed()).toBe(false);
  });

  it("round-trips both directions", () => {
    const storage = memoryStorage();
    stubWindow(storage);
    writeStoredCollapsed(true);
    expect(readStoredCollapsed()).toBe(true);
    writeStoredCollapsed(false);
    expect(readStoredCollapsed()).toBe(false);
  });

  it("is a silent no-op when storage throws", () => {
    stubWindow({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => writeStoredCollapsed(true)).not.toThrow();
  });
});
