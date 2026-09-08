/**
 * Filesystem Skills: `SKILL.md` packs the Chat Agent may use (Story 8.6).
 *
 * A SCAN, NOT A REGISTRY. There is no install step and no database: a Skill is a
 * directory containing a `SKILL.md`, and the answer to "which Skills exist" is
 * whatever is on disk right now. That is the whole acceptance criterion —
 * "scanned without reinstall" — and it is why the kernel's enablement map
 * records DECISIONS (id → `false`) rather than an inventory: an inventory would
 * go stale the moment the owner added a folder, and every new Skill would
 * silently arrive switched off.
 *
 * This is NOT `src/lib/agent-skills.ts`. That module is Studio `/agents`' CRUD
 * over kernel-stored skill records for a different product; these are files on
 * the owner's laptop that the local Agent reads. Retargeting either at the other
 * would give one of them the wrong storage and the wrong lifecycle.
 *
 * Imports nothing from `src/lib` (AD-6).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** How deep a scan walks before giving up. Two levels of grouping is plenty. */
const MAX_DEPTH = 4;

/**
 * Where Skills are looked for, in precedence order.
 *
 * PROJECT first, USER second: a pack checked into this repo beside the sidecar
 * is the one the owner is actively working on, and it should win over a
 * same-named one in their home directory.
 */
export function skillRoots({
  cwd = process.cwd(),
  home = os.homedir(),
} = {}) {
  return [
    { scope: "project", dir: path.join(cwd, "skills") },
    { scope: "user", dir: path.join(home, ".workwiki", "skills") },
  ];
}

/**
 * A Skill's stable id.
 *
 * `scope:relative/dir`, derived from WHERE the pack is rather than from the
 * `name:` in its frontmatter. Two packs may legitimately claim the same name —
 * one in the repo, one in the owner's home — and an owner who disabled one must
 * not silently disable the other. Frontmatter is also editable, and an id that
 * moved when the owner retitled a Skill would lose their decision about it.
 */
export function skillId(scope, relativeDir) {
  return `${scope}:${relativeDir.split(path.sep).join("/")}`;
}

/**
 * The `name` and `description` out of a `SKILL.md`.
 *
 * A DELIBERATELY SMALL PARSER, not YAML. Only two scalar keys out of the leading
 * `---` block are read, so there is no dependency, no anchor expansion and no
 * arbitrary object graph coming out of a file the Agent will later be told
 * about. Anything it cannot find falls back to the directory name, because a
 * Skill with a malformed header is still a Skill and hiding it would be a silent
 * failure the owner cannot see.
 */
export function parseSkillFrontmatter(text, fallbackName) {
  const out = { name: fallbackName, description: "" };
  if (typeof text !== "string") return out;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[kv[1]] = value;
  }
  return out;
}

/**
 * Every `SKILL.md` under the roots, with its enablement applied.
 *
 * ABSENT FROM THE MAP MEANS ENABLED — see `AppConfig.skillEnablement`. Only an
 * explicit `false` hides a Skill, and hiding means hiding everywhere: from
 * `/skill` completion, from injection, and from the Agent's Skill file reads.
 * "Disabled but still readable" would be a switch that does nothing.
 *
 * A root that does not exist is not an error. Most machines have no
 * `~/.workwiki/skills`, and treating its absence as a failure would make the
 * common case log noise.
 */
export async function scanSkills({
  roots = skillRoots(),
  enablement = {},
} = {}) {
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    for (const dir of await walkForSkills(root.dir)) {
      const relative = path.relative(root.dir, dir);
      const id = skillId(root.scope, relative);
      // Project wins over user for the same relative path. First writer stays.
      if (seen.has(relative)) continue;
      seen.add(relative);
      let text = "";
      try {
        text = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const meta = parseSkillFrontmatter(text, path.basename(dir));
      found.push({
        id,
        name: meta.name,
        description: meta.description,
        scope: root.scope,
        enabled: enablement[id] !== false,
        path: path.join(dir, "SKILL.md"),
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function walkForSkills(root, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    out.push(root);
  }
  for (const entry of entries) {
    // Hidden directories are skipped: `.git` and friends are not Skill packs,
    // and walking them is how a scan of a monorepo takes seconds.
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    out.push(...(await walkForSkills(path.join(root, entry.name), depth + 1)));
  }
  return out;
}

/**
 * The body of one ENABLED Skill, or `null`.
 *
 * The enablement check is HERE rather than at the call site because this is the
 * only function that reads a Skill's bytes. A caller that could ask for a
 * disabled Skill's text by id would make the switch cosmetic — see
 * {@link scanSkills}.
 */
export async function readSkill(id, { roots = skillRoots(), enablement = {} } = {}) {
  const skills = await scanSkills({ roots, enablement });
  const skill = skills.find((entry) => entry.id === id);
  if (!skill || !skill.enabled) return null;
  try {
    return { ...skill, text: await fs.readFile(skill.path, "utf8") };
  } catch {
    return null;
  }
}
