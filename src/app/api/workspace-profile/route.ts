import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { getCurrentWiki, type WikiRecord } from "@/lib/wikis";
import {
  emptyWorkspaceProfile,
  getWorkspaceProfile,
  readLegacyTenantProfile,
  saveWorkspaceProfile,
} from "@/lib/workspace-profile";
import { parseWorkspaceProfileInput } from "@/lib/workspace-profile-schema";

/**
 * The Workspace Purpose of the ACTIVE Wiki.
 *
 * The profile is per-Wiki, so this route is scoped by the `current` pointer of
 * `getPrincipal().handle`'s registry — no new auth or tenant model is involved.
 * The response names the Wiki so Settings can say whose purpose is on screen;
 * with no Wiki at all there is nothing to edit, and a PUT is refused rather
 * than inventing a home for the bytes.
 *
 * A PUT must also name the Wiki it was composed against. The form resolves the
 * active Wiki once at mount while this route re-resolves it per request, so a
 * pointer that moves in between (a second tab, the workbench switcher) would
 * otherwise write one Wiki's on-screen bytes over another's stored profile —
 * the same silent cross-Wiki overwrite this route's own storage change exists
 * to remove, merely relocated from the seeder.
 */

const NO_WIKI =
  "Create a wiki first — the Workspace Purpose belongs to the active wiki.";

const WIKI_DRIFTED =
  "The active wiki changed since this form was loaded — reload before saving, or your edits would overwrite a different wiki's Workspace Purpose.";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const wiki = await getCurrentWiki(principal.handle);
    return NextResponse.json({
      // With no Wiki, show the retired tenant-global profile if one is still
      // there: an owner mid-migration can at least SEE what they wrote instead
      // of an empty form. Read-only — the form stays disabled, `wiki` stays
      // null, and nothing here writes or deletes the legacy file.
      profile: wiki
        ? await getWorkspaceProfile(principal.handle, wiki.id)
        : ((await readLegacyTenantProfile(principal.handle)) ??
          emptyWorkspaceProfile()),
      readOnly: isReadOnly(),
      wiki: wiki ? { id: wiki.id, name: wiki.name } : null,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: "Settings are read-only in this deployment." },
      { status: 403 },
    );
  }
  // Resolve the Wiki BEFORE parsing the profile fields, and OUTSIDE the input
  // try: with no Wiki there is nowhere for a valid profile to go either, and
  // "create a wiki first" is the actionable message rather than a field-level
  // complaint about the payload — but a registry that cannot be READ is not the
  // caller's input being wrong. GET answers 500 for that exact condition, and
  // answering 400 here would tell the owner their edit was rejected when
  // storage was merely unreadable.
  let wiki: WikiRecord | null;
  try {
    wiki = await getCurrentWiki(principal.handle);
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
  try {
    const body = (await request.json()) as unknown;
    if (!wiki) throw new ClientInputError(NO_WIKI);
    // The body's `wikiId` is the Wiki the form was composed against. Refusing on
    // a mismatch is what makes the save safe: writing to the NOW-active Wiki
    // instead would silently clobber a profile the owner never had on screen.
    // ABSENT is tolerated so a non-form caller still works. PRESENT-but-wrong is
    // refused whatever its type — gating on `typeof claimed === "string"` would
    // let a `null` or a number past the guard and straight into that same
    // silent cross-Wiki overwrite, which is the one thing this route must not do.
    const claimed =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).wikiId
        : undefined;
    if (claimed !== undefined && claimed !== wiki.id) {
      throw new ClientInputError(WIKI_DRIFTED);
    }
    const profile = await saveWorkspaceProfile(
      principal.handle,
      wiki.id,
      // Extra keys (`wikiId` among them) are dropped by the parser, so the
      // stored profile carries only the schema's own fields.
      parseWorkspaceProfileInput(body),
    );
    return NextResponse.json({ profile, wiki: { id: wiki.id, name: wiki.name } });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}
