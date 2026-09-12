/** Node-only startup fingerprint. Never exposes paths or credentials on the wire. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function localSidecarIdentity(root, dataDir = process.env.DATA_DIR || root) {
  const canonical = (value) => {
    let candidate = path.resolve(value);
    const missing = [];
    while (true) {
      try { return path.join(realpathSync(candidate), ...missing.reverse()); }
      catch {
        const parent = path.dirname(candidate);
        if (parent === candidate) return path.resolve(value);
        missing.push(path.basename(candidate));
        candidate = parent;
      }
    }
  };
  let revision = "unversioned";
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { /* Packaged deployments need not contain Git metadata. */ }
  return createHash("sha256")
    .update(JSON.stringify([canonical(root), canonical(dataDir), revision]))
    .digest("hex");
}
