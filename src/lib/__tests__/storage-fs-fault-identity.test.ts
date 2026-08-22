/**
 * `atomicWrite` error identity, under faults the filesystem will not stage for
 * us (an unlink that cannot unlink, a close that cannot close).
 *
 * Why this file exists separately: `storage-fs.test.ts` runs against the real
 * `node:fs/promises`, and these two rows need it mocked. Why the rows exist at
 * all: callers branch on the error OBJECT, not on a message — `wikis.ts`'s
 * DW-20 compensation re-throws the original storage failure, and the research
 * registry's suite asserts the very object — so a cleanup step that replaces
 * the diagnosis with its own is a silent misdiagnosis at every one of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

/** Faults the mocked `node:fs/promises` injects; reset between rows. */
const control: {
  rmError: Error | null;
  closeError: Error | null;
  writeError: Error | null;
} = { rmError: null, closeError: null, writeError: null };

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    default: real,
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (control.rmError) throw control.rmError;
      return real.rm(...args);
    },
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      return {
        chmod: (mode: number) => handle.chmod(mode),
        writeFile: async (data: string | Buffer) => {
          if (control.writeError) throw control.writeError;
          return handle.writeFile(data);
        },
        sync: () => handle.sync(),
        close: async () => {
          await handle.close();
          if (control.closeError) throw control.closeError;
        },
      };
    },
  };
});

import * as fs from "node:fs/promises";
import { FilesystemStorageProvider } from "../storage/filesystem";

describe("atomicWrite fault identity", () => {
  let tmpDir: string;
  let provider: FilesystemStorageProvider;

  beforeEach(async () => {
    control.rmError = null;
    control.closeError = null;
    control.writeError = null;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yopedia-fault-identity-"));
    provider = new FilesystemStorageProvider(tmpDir);
  });

  afterEach(async () => {
    control.rmError = null;
    control.closeError = null;
    control.writeError = null;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports the write fault, not the tmp file it then failed to remove", async () => {
    await provider.writeFile("registry.json", "old");
    const fault = new Error("ENOSPC: no space left on device");
    control.writeError = fault;
    control.rmError = new Error("EPERM: operation not permitted, unlink");

    await expect(provider.writeFile("registry.json", "new")).rejects.toBe(fault);

    // The destination never moved, and the leaked tmp file is the documented
    // lesser harm — invisible to every caller, because listing hides it.
    expect(await provider.readFile("registry.json")).toBe("old");
    expect((await provider.listFiles(".")).map((e) => e.name)).toEqual([
      "registry.json",
    ]);
  });

  it("reports the write fault, not a close that failed on top of it", async () => {
    await provider.writeFile("registry.json", "old");
    const fault = new Error("EIO: i/o error");
    control.writeError = fault;
    control.closeError = new Error("EBADF: bad file descriptor, close");

    await expect(provider.writeFile("registry.json", "new")).rejects.toBe(fault);
    expect(await provider.readFile("registry.json")).toBe("old");
  });

  it("surfaces a close failure on the clean path and publishes nothing", async () => {
    await provider.writeFile("registry.json", "old");
    const closeFault = new Error("EBADF: bad file descriptor, close");
    control.closeError = closeFault;

    await expect(provider.writeFile("registry.json", "new")).rejects.toBe(closeFault);

    // A handle that could not be closed has no proven-flushed bytes behind it,
    // so it must not be renamed into place — the old file stands.
    expect(await provider.readFile("registry.json")).toBe("old");
  });
});
