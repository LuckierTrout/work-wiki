import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { getCurrentWiki, type WikiRecord } from "@/lib/wikis";
import {
  checkWritePrecondition,
  IF_MATCH_HEADER,
  objectVersion,
} from "@/lib/write-precondition";
import {
  emptyWorkspaceProfile,
  getWorkspaceProfile,
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
 *
 * AND A PUT MUST NAME THE PROFILE IT WAS COMPOSED AGAINST (DW-145). The
 * `wikiId` guard above is about the WRONG Wiki; it says nothing about two tabs
 * open on the SAME one, where the later save silently put back every field the
 * earlier one changed. The version is {@link objectVersion} of the profile this
 * route just read — `workspace-profile.json` is rewritten wholesale by
 * `putWorkspaceProfile`'s own serializer, which is the case that function
 * reserves itself for, and it holds no key material, so nothing here is the
 * boundary AD-23 moved `/api/settings` off a derived version to protect. GET
 * publishes it, the form returns it as `If-Match`, and a stale save is refused
 * with the 412/428 shape the page, artifact and settings writes already answer.
 * The two guards are INDEPENDENT: neither supersedes the other.
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
    // With no Wiki there is no profile to read, so the form is seeded with an
    // empty one (DW-137). This branch used to show the retired tenant-global
    // file if one was still there; that address no longer exists on any live
    // read path — `workspace-profile-backfill.ts` relocates it once from the
    // maintenance scan — and the form is disabled with `wiki: null` either way,
    // so what it displayed was a purpose nothing could save.
    const profile = wiki
      ? await getWorkspaceProfile(principal.handle, wiki.id)
      : emptyWorkspaceProfile();
    return NextResponse.json({
      profile,
      readOnly: isReadOnly(),
      wiki: wiki ? { id: wiki.id, name: wiki.name } : null,
      // Of the profile in THIS body, computed from the one variable above — two
      // reads would be two moments, and the form would be seeded from one while
      // conditioned on the other. Published even with no Wiki: the value
      // describes the profile shown, and a form that cannot save it simply never
      // sends it back.
      version: objectVersion(profile),
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
  // A BODY THAT IS NOT JSON GETS ITS OWN BRANCH (DW-140), exactly as
  // `POST /api/wikis` does. Falling into the guard try below answered 400 with
  // whatever sentence `JSON.parse` happened to throw — "Unexpected token o in
  // JSON at position 1" — which names the parser's cursor rather than the
  // caller's mistake, and is the only error this route relayed that no human
  // wrote.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  try {
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
    // Extra keys (`wikiId` among them) are dropped by the parser, so the
    // stored profile carries only the schema's own fields.
    const input = parseWorkspaceProfileInput(body);
    // THE WRITE PRECONDITION (DW-145), after every refusal that does not depend
    // on the stored bytes and immediately before the write.
    //
    // Read HERE rather than at the top of the handler: this write is a whole-
    // object REPLACE, so unlike `/api/settings` there is no merge base already
    // in hand, and a request refused for a drifted Wiki or an invalid field
    // must not learn a version it was never going to use (`IF_MATCH_HEADER`).
    // The visible consequence is deliberate: a stale save that ALSO carries a
    // bad field is answered 400 for the field, not 412.
    //
    // `getWorkspaceProfile`, not `readOwnProfile`, because it is what GET seeded
    // the form from: the version has to be OF the bytes the form was composed
    // against, or a save is conditioned on a profile the owner never saw.
    //
    // Outside the lock, like every other caller of this check: the residual
    // two-requests-in-one-instant window stays exactly as `checkWritePrecondition`
    // records it. This closes the one an OPEN EDITOR creates.
    //
    // ITS OWN try/catch, answering 500, for the same reason the registry read
    // above has one: `readOwnProfile` rethrows every non-ENOENT read error, so a
    // directory in the file's place or a storage outage would otherwise fall
    // into the 400 below and tell the owner their valid edit was rejected when
    // storage was merely unreadable — relayed as whatever the filesystem
    // happened to say, which is the same machine-authored sentence class DW-140
    // just removed from this route. GET answers 500 for this exact condition.
    let current: Awaited<ReturnType<typeof getWorkspaceProfile>>;
    try {
      current = await getWorkspaceProfile(principal.handle, wiki.id);
    } catch (error) {
      return NextResponse.json(
        { error: getErrorMessage(error) },
        { status: 500 },
      );
    }
    const precondition = checkWritePrecondition(
      request.headers.get(IF_MATCH_HEADER),
      objectVersion(current),
    );
    if (!precondition.ok) {
      return NextResponse.json(
        { error: precondition.error },
        { status: precondition.status },
      );
    }
    const profile = await saveWorkspaceProfile(principal.handle, wiki.id, input);
    return NextResponse.json({
      profile,
      wiki: { id: wiki.id, name: wiki.name },
      // The version of what was JUST WRITTEN, so a form that saves twice in one
      // session is conditioned on the save it made rather than on the profile it
      // loaded — otherwise the owner's second save is refused for a change they
      // made themselves.
      version: objectVersion(profile),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}
