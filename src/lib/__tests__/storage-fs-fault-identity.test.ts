/**
 * Write-path rows that need `node:fs/promises` MOCKED, which is why they live
 * apart from `storage-fs.test.ts` and its real filesystem. Two kinds:
 *
 * ERROR IDENTITY, under faults the filesystem will not stage for us (an unlink
 * that cannot unlink, a close that cannot close). Callers branch on the error
 * OBJECT, not on a message — `wikis.ts`'s DW-20 compensation re-throws the
 * original storage failure, and the research registry's suite asserts the very
 * object — so a cleanup step that replaces the diagnosis with its own is a
 * silent misdiagnosis at every one of them. The batch door carries the same
 * promise for the entry that faulted, so it is pinned the same way.
 *
 * INTERLEAVING, for the one thing DW-371 turns on: `writeFileIfMatch` re-checks
 * the etag AFTER staging its replacement and immediately before the rename. A
 * competing write that lands in that gap is exactly what the re-check exists to
 * catch, and it cannot be staged from outside — a test can only get in there by
 * hooking a step of the write itself, which is what `control.onSync` is for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

/** Faults the mocked `node:fs/promises` injects; reset between rows. */
const control: {
  rmError: Error | null;
  closeError: Error | null;
  writeError: Error | null;
  /** Runs INSIDE the first `sync()` of a write, then clears itself. */
  onSync: (() => Promise<void>) | null;
} = { rmError: null, closeError: null, writeError: null, onSync: null };

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
        sync: async () => {
          // Cleared BEFORE running, so the hook's own writes — which go through
          // this same mocked `open` — do not re-enter it.
          const hook = control.onSync;
          control.onSync = null;
          if (hook) await hook();
          return handle.sync();
        },
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
    control.onSync = null;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yopedia-fault-identity-"));
    provider = new FilesystemStorageProvider(tmpDir);
  });

  afterEach(async () => {
    control.rmError = null;
    control.closeError = null;
    control.writeError = null;
    control.onSync = null;
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

// ---------------------------------------------------------------------------
// writeBatch fault identity (DW-293)
// ---------------------------------------------------------------------------

/**
 * The batch door promises to reject with "the faulting entry's own error,
 * unchanged in identity". `storage-fs.test.ts` can stage a fault at the RENAME
 * (a destination that is a directory) but not one during STAGING, and it cannot
 * make the cleanup itself fail — both need the module mocked.
 */
describe("writeBatch fault identity", () => {
  let tmpDir: string;
  let provider: FilesystemStorageProvider;

  beforeEach(async () => {
    control.rmError = null;
    control.closeError = null;
    control.writeError = null;
    control.onSync = null;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yopedia-batch-identity-"));
    provider = new FilesystemStorageProvider(tmpDir);
  });

  afterEach(async () => {
    control.rmError = null;
    control.closeError = null;
    control.writeError = null;
    control.onSync = null;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports the staging fault itself, and publishes none of the window", async () => {
    const fault = new Error("ENOSPC: no space left on device");
    control.writeError = fault;

    await expect(
      provider.writeBatch([
        { path: "a.md", body: "alpha" },
        { path: "b.md", body: "beta" },
      ]),
    ).rejects.toBe(fault);

    // Staging is what failed, so nothing reached a destination.
    expect(await provider.fileExists("a.md")).toBe(false);
    expect(await provider.fileExists("b.md")).toBe(false);
  });

  it("keeps the staging fault when the window's cleanup cannot unlink either", async () => {
    const fault = new Error("EIO: i/o error");
    control.writeError = fault;
    control.rmError = new Error("EPERM: operation not permitted, unlink");

    await expect(
      provider.writeBatch([{ path: "a.md", body: "alpha" }]),
    ).rejects.toBe(fault);

    // The leaked tmp file is the documented lesser harm — invisible to callers
    // because listing hides it — and it must not become the reported cause.
    expect((await provider.listFiles(".")).map((e) => e.name)).toEqual([]);
  });

  it("keeps a close fault on the otherwise-clean path and publishes nothing", async () => {
    const closeFault = new Error("EBADF: bad file descriptor, close");
    control.closeError = closeFault;

    await expect(
      provider.writeBatch([{ path: "a.md", body: "alpha" }]),
    ).rejects.toBe(closeFault);

    expect(await provider.fileExists("a.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The compare-and-set re-check (DW-371)
// ---------------------------------------------------------------------------

/**
 * Every CAS row in `storage-fs.test.ts` performs the competing write BEFORE the
 * call, so the cheap pre-check refuses and the staged re-check is never the
 * thing that decides. These rows land the competing write inside the write
 * itself, which is the only window the re-check was added for — remove the
 * precondition argument from `writeFileIfMatch` and only these fail.
 */
describe("writeFileIfMatch re-checks after staging", () => {
  let tmpDir: string;
  let provider: FilesystemStorageProvider;

  beforeEach(async () => {
    control.rmError = null;
    control.closeError = null;
    control.writeError = null;
    control.onSync = null;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yopedia-cas-recheck-"));
    provider = new FilesystemStorageProvider(tmpDir);
  });

  afterEach(async () => {
    control.rmError = null;
    control.closeError = null;
    control.writeError = null;
    control.onSync = null;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Scratch files a refused CAS must not leave behind. */
  async function tmpArtifactsIn(rel: string): Promise<string[]> {
    const entries = await fs.readdir(path.join(tmpDir, rel));
    return entries.filter((name) => /^\.tmp-.*\.tmp$/.test(name));
  }

  it("refuses when another writer lands AFTER the pre-check passed", async () => {
    await provider.writeFile("cas.md", "AAA");
    const { etag } = await provider.readFileWithEtag("cas.md");

    // Fires inside the staging flush: the pre-check has already passed and read
    // "AAA", and the rename has not happened yet.
    control.onSync = async () => {
      await provider.writeFile("cas.md", "BBB");
    };

    expect(await provider.writeFileIfMatch("cas.md", "CCC", etag)).toBe(false);

    // The other writer's content stands, and the refused replacement left
    // neither a published file nor a scratch one.
    expect(await provider.readFile("cas.md")).toBe("BBB");
    expect(await tmpArtifactsIn(".")).toEqual([]);
  });

  it("still publishes when nothing landed in that window", async () => {
    await provider.writeFile("cas.md", "AAA");
    const { etag } = await provider.readFileWithEtag("cas.md");

    // The same hook, doing nothing: the re-check must not refuse on its own.
    control.onSync = async () => {};

    expect(await provider.writeFileIfMatch("cas.md", "CCC", etag)).toBe(true);
    expect(await provider.readFile("cas.md")).toBe("CCC");
    expect(await tmpArtifactsIn(".")).toEqual([]);
  });

  it("refuses a competing write that matched the old byte length exactly", async () => {
    await provider.writeFile("cas.md", "AAA");
    const { etag } = await provider.readFileWithEtag("cas.md");

    // Same length as what the pre-check read — the case an `mtime-size` tag
    // could not see even when it was checked at the last possible moment.
    control.onSync = async () => {
      await provider.writeFile("cas.md", "BBB");
    };

    expect(await provider.writeFileIfMatch("cas.md", "ZZZ", etag)).toBe(false);
    expect(await provider.readFile("cas.md")).toBe("BBB");
  });
});
