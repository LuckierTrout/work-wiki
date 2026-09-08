/**
 * Kernel flag: Source path → marked meeting.
 *
 * Read at ingest-run and from Preview/Sources. Not stuffed into YAML `sources[]`.
 */

import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { assertWritable, READ_ONLY_REFUSAL } from "./read-only";
import { parseSources } from "./sources";
import { sourceIdentityKeys, workbenchSourcePath } from "./source-delete";
import { getStorage } from "./storage";
import { readWikiPageWithFrontmatter, tenantForOwner, validateTenant } from "./wiki";

export type SourceMeetingMap = Record<string, boolean>;

function meetingPath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/source-meeting.json`;
}

function lockKey(owner: string): string {
  return `source-meeting:${tenantForOwner(owner)}`;
}

async function readMap(owner: string): Promise<SourceMeetingMap> {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await getStorage().readFile(meetingPath(owner)));
    } catch {
      return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: SourceMeetingMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

export function canonicalMeetingPath(path: string): string | null {
  return workbenchSourcePath(path);
}

function meetingLookupKeys(path: string): string[] {
  const keys = sourceIdentityKeys(path);
  if (keys.length > 0) return keys;
  const prefixed = workbenchSourcePath(`raw/sources/${path.replace(/^\/+/, "")}`);
  if (prefixed) return sourceIdentityKeys(prefixed);
  return path.trim() ? [path.trim()] : [];
}

export async function isSourceMeeting(owner: string, path: string): Promise<boolean> {
  const map = await readMap(owner);
  return meetingLookupKeys(path).some((key) => map[key] === true);
}

export async function setSourceMeeting(
  owner: string,
  path: string,
  meeting = true,
): Promise<{ path: string; meeting: boolean }> {
  assertWritable(READ_ONLY_REFUSAL.sourceMeeting);
  const canonical = canonicalMeetingPath(path);
  if (!canonical) throw new Error("Invalid source path.");
  return withFileLock(lockKey(owner), async () => {
    const map = await readMap(owner);
    if (meeting) map[canonical] = true;
    else delete map[canonical];
    await getStorage().writeFile(meetingPath(owner), JSON.stringify(map, null, 2));
    return { path: canonical, meeting };
  });
}

export async function firstCitedSourcePath(slug: string): Promise<string | undefined> {
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) return undefined;
  const sources = parseSources(page.frontmatter.sources as string | string[] | undefined);
  for (const source of sources) {
    if (source.url.startsWith("raw/sources/")) return source.url;
    const fromUrl = workbenchSourcePath(source.url);
    if (fromUrl) return fromUrl;
  }
  return undefined;
}

/**
 * Whether this successful compile should enqueue meeting Todo extract,
 * and which Source path to attach.
 */
export async function meetingExtractTarget(
  owner: string,
  input: { origin?: "plaud"; sourcePath?: string; slug: string },
): Promise<{ sourcePath?: string } | null> {
  const fromTask = input.sourcePath?.trim()
    ? (canonicalMeetingPath(input.sourcePath) ?? input.sourcePath.trim())
    : undefined;
  if (input.origin === "plaud") {
    return { ...(fromTask ? { sourcePath: fromTask } : {}) };
  }
  if (fromTask && (await isSourceMeeting(owner, fromTask))) {
    return { sourcePath: fromTask };
  }
  const cited = fromTask ?? (await firstCitedSourcePath(input.slug));
  if (cited && (await isSourceMeeting(owner, cited))) {
    return { sourcePath: cited };
  }
  return null;
}
