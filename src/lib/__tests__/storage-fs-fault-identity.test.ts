/**
 * Create-only and `atomicWrite` error identity, under faults the filesystem will
 * not stage for us (an unlink that cannot unlink, a close that cannot close, a
 * `link` the mount refuses).
 *
 * Why this file exists separately: `storage-fs.test.ts` runs against the real
 * `node:fs/promises`, and these rows need it mocked. Why the rows exist at
 * all: callers branch on the error OBJECT, not on a message — `wikis.ts`'s
 * DW-20 compensation re-throws the original storage failure, and the research
 * registry's suite asserts the very object — so a cleanup step that replaces
 * the diagnosis with its own is a silent misdiagnosis at every one of them.
 *
 * AND WHY THE LINK-LESS FALLBACK'S BEHAVIOUR ROWS LIVE HERE TOO (DW-573),
 * rather than beside the other create-only rows in the real-fs suite: no
 * filesystem reachable from a test host answers `link(2)` with `ENOSYS`/`EXDEV`
 * on demand, and `vi.spyOn` cannot patch a single export of an ESM namespace
 * ("Cannot spy on export 'link'. Module namespace is not configurable in ESM").
 * The passthrough mock below is the only seam that can stage it — and because
 * everything except the injected call is the REAL `node:fs/promises`, the bytes
 * these rows publish really land and the no-scratch assertions really read the
 * directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

/** Faults the mocked `node:fs/promises` injects; reset between rows. */
const control: {
  rmError: Error | null;
  closeError: Error | null;
  writeError: Error | null;
  linkError: Error | null;
  renameError: Error | null;
  lstatError: Error | null;
  /**
   * Runs INSIDE the mocked `rename`, i.e. inside the fallback's publication
   * window, before the rename lands. The only seam this suite has for observing
   * state that exists solely while `createOnlyWrite` is mid-flight.
   */
  onRename: (() => Promise<void> | void) | null;
} = {
  rmError: null,
  closeError: null,
  writeError: null,
  linkError: null,
  renameError: null,
  lstatError: null,
  onRename: null,
};

/** An errno-shaped fault, since the provider branches on `code`. */
function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    default: real,
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (control.rmError) throw control.rmError;
      return real.rm(...args);
    },
    link: async (...args: Parameters<typeof real.link>) => {
      if (control.linkError) throw control.linkError;
      return real.link(...args);
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (control.onRename) await control.onRename();
      if (control.renameError) throw control.renameError;
      return real.rename(...args);
    },
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      if (control.lstatError) throw control.lstatError;
      return real.lstat(...args);
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

function resetControl(): void {
  control.rmError = null;
  control.closeError = null;
  control.writeError = null;
  control.linkError = null;
  control.renameError = null;
  control.lstatError = null;
  control.onRename = null;
}

describe("atomicWrite fault identity", () => {
  let tmpDir: string;
  let provider: FilesystemStorageProvider;

  beforeEach(async () => {
    resetControl();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yopedia-fault-identity-"));
    provider = new FilesystemStorageProvider(tmpDir);
  });

  afterEach(async () => {
    resetControl();
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


/**
 * The create-only door under the two faults a real filesystem will not stage:
 * a `link` that fails for a reason other than "the name is taken", and a mount
 * with no hard links at all (DW-573, DW-574).
 *
 * The fallback is the interesting half. `fs.link` is exclusive on its own — the
 * name either appears or the call fails — so losing it means the exclusivity has
 * to come from somewhere, and the answer is the publication lock the body
 * already holds plus a probe of the destination. These rows pin what that costs
 * and, more importantly, what it must never cost: the existing bytes.
 */
describe("createOnlyWrite fault identity and the link-less fallback", () => {
  let tmpDir: string;
  let provider: FilesystemStorageProvider;

  /** Scratch left in the destination's own directory, read from the real fs. */
  async function scratchNames(): Promise<string[]> {
    return (await fs.readdir(tmpDir)).filter((name) =>
      /^\.tmp-.*\.tmp$/.test(name),
    );
  }

  beforeEach(async () => {
    resetControl();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yopedia-create-only-fault-"));
    provider = new FilesystemStorageProvider(tmpDir);
  });

  afterEach(async () => {
    resetControl();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("propagates a link failure that is neither EEXIST nor link-less, publishing nothing", async () => {
    // The rule the fallback must not erode: a code OUTSIDE the link-less set is
    // a real fault, not a portability fact, and it reaches the caller as the
    // very object it was thrown as. An `EIO` retried through a rename would
    // publish bytes off a dying disk and report success.
    const fault = errno("EIO", "i/o error, link");
    control.linkError = fault;

    await expect(provider.writeFileIfAbsent("create.md", "bytes")).rejects.toBe(
      fault,
    );

    expect(await provider.fileExists("create.md")).toBe(false);
    expect(await scratchNames()).toEqual([]);
  });

  it("reports the link fault, not the scratch file it then failed to remove", async () => {
    const fault = errno("EIO", "i/o error, link");
    control.linkError = fault;
    control.rmError = errno("EPERM", "operation not permitted, unlink");

    await expect(provider.writeFileIfAbsent("create.md", "bytes")).rejects.toBe(
      fault,
    );

    // The leaked scratch file is the documented lesser harm — `listFiles`
    // hides it — and it must not become the diagnosis the caller branches on.
    control.rmError = null;
    expect(await scratchNames()).toHaveLength(1);
    expect((await provider.listFiles(".")).map((e) => e.name)).toEqual([]);
  });

  it.each(["EPERM", "ENOSYS", "EXDEV", "EOPNOTSUPP", "ENOTSUP"])(
    "publishes through the rename fallback when link answers %s",
    async (code) => {
      // Every code in `LINKLESS_CODES`, one row each: a mount that refuses
      // `link(2)` must still serve a Source arrival, which is the whole of
      // DW-573. Asserted per code because the set is the contract — dropping
      // one silently returns that mount to a hard failure.
      control.linkError = errno(code, "link");

      await expect(
        provider.writeFileIfAbsent("create.md", "published"),
      ).resolves.toBe(true);

      expect(await provider.readFile("create.md")).toBe("published");
      expect(await scratchNames()).toEqual([]);
    },
  );

  it("still lets exactly one of two concurrent creators win, without link's help", async () => {
    // THE PROPERTY THE FALLBACK HAS TO CARRY. `fs.link` is exclusive on its
    // own — the name either appears or the call fails — so once it is gone the
    // exclusivity has to come from the publication lock this body already
    // holds: the probe of the loser has to run on the far side of the winner's
    // rename rather than beside it.
    //
    // WHAT THIS ROW DOES AND DOES NOT PIN. Both calls are in ONE process, so
    // `withFileLock`'s in-process promise chain (`lock.ts`) is what orders
    // them here — this row would stay green against a
    // `withFilesystemPublicationLock` that never created a lockfile at all.
    // The CROSS-process half, which is the half a second isolate on the same
    // link-less mount depends on, is pinned by the row below.
    control.linkError = errno("ENOSYS", "function not implemented, link");
    const values = ["first", "second"];

    const results = await Promise.all(
      values.map((value) => provider.writeFileIfAbsent("create.md", value)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.findIndex(Boolean);
    expect(await provider.readFile("create.md")).toBe(values[winner]);
    expect(await scratchNames()).toEqual([]);
  });

  it("holds the on-disk publication lockfile across the fallback's probe and rename", async () => {
    // The cross-process half of the fallback's exclusivity claim, observed from
    // inside the window it has to cover. `withFileLock`'s promise chain orders
    // callers within ONE process and can do nothing about a second isolate on
    // the same mount; only the `fs.open(lockPath, "wx")` lockfile can, and
    // nothing else in this suite would notice if it stopped being created.
    //
    // The name mirrors `publicationLockPath`: sha256 of the ABSOLUTE
    // destination path, `.lock`. Spelled out rather than imported so that a
    // change to the scheme has to be looked at rather than silently followed.
    const abs = path.join(tmpDir, "create.md");
    const lockName = `${createHash("sha256").update(abs).digest("hex")}.lock`;
    const lockDir = path.join(tmpDir, ".storage-locks");
    control.linkError = errno("ENOSYS", "function not implemented, link");

    let heldDuringPublication: string[] = [];
    control.onRename = async () => {
      heldDuringPublication = await fs.readdir(lockDir);
    };

    await expect(
      provider.writeFileIfAbsent("create.md", "published"),
    ).resolves.toBe(true);

    // Held while the rename was publishing…
    expect(heldDuringPublication).toEqual([lockName]);
    // …and released after, so the next arrival on this path is not deadlocked
    // behind a lock nobody holds.
    expect(await fs.readdir(lockDir)).toEqual([]);
    expect(await provider.readFile("create.md")).toBe("published");
  });

  it("answers false on a DANGLING SYMLINK destination, exactly as fs.link would", async () => {
    // The one place the primary and fallback publications could disagree about
    // what "the name is taken" means. `link(2)` never follows its newpath, so
    // on a linking mount a dangling symlink at the destination answers EEXIST
    // and the create-only door returns `false`. A probe using `stat` would
    // follow that symlink, get ENOENT from the missing target, read "absent",
    // and rename straight over the link — the same call returning `true` and
    // destroying a name, decided by nothing but which mount this is.
    const dest = path.join(tmpDir, "create.md");
    await fs.symlink(path.join(tmpDir, "no-such-target"), dest);
    control.linkError = errno("EXDEV", "cross-device link");

    await expect(
      provider.writeFileIfAbsent("create.md", "replacement"),
    ).resolves.toBe(false);

    // The symlink itself is untouched — still a symlink, still dangling.
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(true);
    expect(await scratchNames()).toEqual([]);
  });

  it("answers false under the fallback when the name is already taken, leaving the bytes", async () => {
    await provider.writeFile("create.md", "already here");
    control.linkError = errno("ENOSYS", "function not implemented, link");

    await expect(
      provider.writeFileIfAbsent("create.md", "replacement"),
    ).resolves.toBe(false);

    // The create-only contract, on the one path that has no `link` to enforce
    // it: the probe is what answers, and the rename is never reached.
    expect(await provider.readFile("create.md")).toBe("already here");
    expect(await scratchNames()).toEqual([]);
  });

  it("propagates the RENAME fault when the fallback itself fails", async () => {
    // The link refusal only told us which path to take; the rename is what
    // failed to publish, so the rename's error is the honest diagnosis.
    const renameFault = errno("ENOSPC", "no space left on device, rename");
    control.linkError = errno("EXDEV", "cross-device link");
    control.renameError = renameFault;

    await expect(
      provider.writeFileIfAbsent("create.md", "bytes"),
    ).rejects.toBe(renameFault);

    control.renameError = null;
    expect(await provider.fileExists("create.md")).toBe(false);
    expect(await scratchNames()).toEqual([]);
  });

  it("propagates a non-ENOENT probe failure rather than renaming over bytes it could not read", async () => {
    // THE ROW THE PROBE EXISTS FOR. Only `ENOENT` means "absent". A probe that
    // swallowed every stat error would answer "absent" for a destination it
    // merely could not read, and the rename below would then REPLACE published
    // bytes and return `true` — the one thing this door exists to prevent.
    await provider.writeFile("create.md", "already here");
    const probeFault = errno("EACCES", "permission denied, lstat");
    control.linkError = errno("ENOSYS", "function not implemented, link");
    control.lstatError = probeFault;

    await expect(
      provider.writeFileIfAbsent("create.md", "replacement"),
    ).rejects.toBe(probeFault);

    control.lstatError = null;
    expect(await provider.readFile("create.md")).toBe("already here");
    expect(await scratchNames()).toEqual([]);
  });

  /**
   * The binary door gets its OWN rows rather than trusting that it shares a
   * body with the string one — the same argument this suite already makes for
   * binary payloads elsewhere. "They delegate to the same private method" is a
   * fact about today's code, not a property a test pins.
   */
  describe("writeAssetIfAbsent", () => {
    it("publishes bytes that are not valid UTF-8 through the rename fallback", async () => {
      const bytes = new Uint8Array([0xff, 0x00, 0x80, 0xfe]);
      control.linkError = errno("ENOSYS", "function not implemented, link");

      await expect(
        provider.writeAssetIfAbsent("create.bin", bytes.buffer as ArrayBuffer),
      ).resolves.toBe(true);

      expect(new Uint8Array(await provider.readAsset("create.bin"))).toEqual(
        bytes,
      );
      expect(await scratchNames()).toEqual([]);
    });

    it("answers false under the fallback when the asset already exists", async () => {
      const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await provider.writeAsset("create.bin", original.buffer as ArrayBuffer);
      control.linkError = errno("EPERM", "operation not permitted, link");

      await expect(
        provider.writeAssetIfAbsent(
          "create.bin",
          new Uint8Array([0, 0]).buffer as ArrayBuffer,
        ),
      ).resolves.toBe(false);

      expect(new Uint8Array(await provider.readAsset("create.bin"))).toEqual(
        original,
      );
      expect(await scratchNames()).toEqual([]);
    });

    it("propagates a link failure that is neither EEXIST nor link-less", async () => {
      const fault = errno("EIO", "i/o error, link");
      control.linkError = fault;

      await expect(
        provider.writeAssetIfAbsent(
          "create.bin",
          new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
        ),
      ).rejects.toBe(fault);

      expect(await provider.fileExists("create.bin")).toBe(false);
      expect(await scratchNames()).toEqual([]);
    });

    it("propagates a non-ENOENT probe failure rather than renaming over an existing asset", async () => {
      const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await provider.writeAsset("create.bin", original.buffer as ArrayBuffer);
      const probeFault = errno("EIO", "i/o error, lstat");
      control.linkError = errno("ENOTSUP", "operation not supported, link");
      control.lstatError = probeFault;

      await expect(
        provider.writeAssetIfAbsent(
          "create.bin",
          new Uint8Array([0, 0]).buffer as ArrayBuffer,
        ),
      ).rejects.toBe(probeFault);

      control.lstatError = null;
      expect(new Uint8Array(await provider.readAsset("create.bin"))).toEqual(
        original,
      );
      expect(await scratchNames()).toEqual([]);
    });
  });
});
