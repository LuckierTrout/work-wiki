import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WRITE_DENIAL,
  WRITE_DENIAL_REALM,
  resolveWriteDenial,
  type WriteDenialAction,
} from "@/lib/write-denial";
import { canWritePage, isRealmRestrictedWrite } from "@/lib/authz";
import type { WriteKind } from "@/lib/authz";

/**
 * The write-denial resolver (DW-122/DW-123).
 *
 * One commons-realm deny reaches nine server surfaces. Before this module each
 * of them answered its own generic sentence while the edit page explained the
 * realm, so the same refusal read differently depending on which door the
 * caller knocked on. The resolver is what makes them one sentence — and, more
 * importantly, what keeps the realm sentence OFF the denies that are not the
 * realm deny. A surface may not claim a page's realm it has not evaluated.
 *
 * So the assertions here come in two families: the realm sentence appears
 * wherever `isRealmRestrictedWrite` holds, and NOWHERE else — including the
 * cases that are easy to get wrong (a private page, an artifact, an
 * agent-scoped page, a page that was never read).
 *
 * WHICH SIDE `"metadata"` IS ON MOVED (DW-121). It used to be the headline
 * example of "nowhere else": the realm gated `body` and `delete` only, so
 * `patchMetadata` kept the generic sentence by construction. The realm is
 * kind-independent now, so a metadata patch on a public knowledge page earns
 * the realm explanation like every other write, and the cases below say so in
 * the family they now belong to.
 */

// The `canWritePage` cross-check below is only meaningful for a NON-admin
// principal: either var exported on the machine running this would make the
// test's principal an admin and turn every "is denied" assertion into a
// vacuous pass through the allow-everything branch.
const savedAdmin = process.env.ADMIN_HANDLES;
const savedOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE;
beforeAll(() => {
  delete process.env.ADMIN_HANDLES;
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
});
afterAll(() => {
  if (savedAdmin === undefined) delete process.env.ADMIN_HANDLES;
  else process.env.ADMIN_HANDLES = savedAdmin;
  if (savedOwner === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = savedOwner;
});

const ACTIONS: WriteDenialAction[] = [
  "edit",
  "delete",
  "revert",
  "reingest",
  "bulkDelete",
];

/**
 * EVERY write kind, and the realm gates all of them (DW-121).
 *
 * This list used to be `["body", "delete"]`, with `"metadata"` held out as the
 * kind the realm never touched. That asymmetry was the defect: the only UI that
 * reaches a metadata patch is the edit page, which refuses the whole screen on
 * `"body"`. Widening the list here is what makes the metadata cases below read
 * as the rule rather than as an exception.
 */
const REALM_KINDS: WriteKind[] = ["body", "metadata", "delete"];

describe("resolveWriteDenial — when the realm sentence is earned", () => {
  it.each(ACTIONS)(
    "explains the realm for a public knowledge page (%s)",
    (action) => {
      for (const kind of REALM_KINDS) {
        expect(
          resolveWriteDenial(action, { visibility: "public" }, kind),
        ).toBe(WRITE_DENIAL_REALM[action]);
      }
    },
  );

  it.each(ACTIONS)("explains the realm for a metadata patch too (%s)", (action) => {
    // The inverse of the case this file used to hold. `patchMetadata` passes
    // `"metadata"`, and since DW-121 the realm gates that kind exactly as it
    // gates `body` and `delete` — so the sentence it answers on a public
    // knowledge page is the realm one, and the "generic by construction"
    // guarantee this door used to carry is retired with the asymmetry.
    expect(resolveWriteDenial(action, { visibility: "public" }, "metadata")).toBe(
      WRITE_DENIAL_REALM[action],
    );
  });

  it("treats a missing visibility as public — the read model's default", () => {
    // A page with no `visibility` key is public everywhere else in the app, so
    // a resolver that required the literal string would silently hand the
    // generic sentence to the commonest realm page there is.
    expect(resolveWriteDenial("delete", {}, "delete")).toBe(
      WRITE_DENIAL_REALM.delete,
    );
  });

  it("says the same thing about the same deny at every surface", () => {
    // The bug in one line: `PUT /api/wiki/[slug]`, `src/mcp.ts` update_page and
    // the edit page all refuse the same write on the same page. One table, so
    // there is only one sentence to read.
    const fm = { visibility: "public" };
    expect(resolveWriteDenial("edit", fm, "body")).toBe(WRITE_DENIAL_REALM.edit);
    expect(WRITE_DENIAL_REALM.edit).toMatch(/public knowledge/i);
    // The way forward, not just the refusal — the same three beats the edit
    // screen has carried since DW-7.
    for (const action of ACTIONS) {
      expect(WRITE_DENIAL_REALM[action]).toMatch(
        /public knowledge pages are agent-maintained/i,
      );
      expect(WRITE_DENIAL_REALM[action]).toMatch(/site admin/i);
    }
  });

  it("tells the edit-screen reader that DELETION is refused too", () => {
    // DW-120 hid the Delete control from a non-admin page owner, so this
    // sentence became the only surface that still says deletion is refused.
    // The clause was dropped once already while every other assertion here
    // stayed green; this is the pin that makes that impossible.
    expect(WRITE_DENIAL_REALM.edit).toMatch(/rewritten\s+or\s+deleted/i);
    // True at both sites that emit it — the edit screen and
    // `PUT /api/wiki/[slug]` — because the realm refuses body writes and
    // deletes on exactly the same page.
    const realmPage = { visibility: "public" };
    expect(resolveWriteDenial("edit", realmPage, "body")).toBe(
      WRITE_DENIAL_REALM.edit,
    );
    expect(isRealmRestrictedWrite(realmPage, "delete")).toBe(true);
  });

  it("phrases the bulk delete for a SELECTION, not for one page", () => {
    // `DELETE /api/ingest/history` refuses a whole selection; a sentence
    // saying "this page" would name a page the caller never pointed at.
    expect(WRITE_DENIAL_REALM.bulkDelete).not.toMatch(/\bthis page\b/i);
    expect(WRITE_DENIAL_REALM.bulkDelete).toMatch(/selected pages/i);
    expect(WRITE_DENIAL.bulkDelete).toMatch(/one or more selected pages/i);
  });
});

describe("resolveWriteDenial — when it must NOT claim a realm", () => {
  it.each(ACTIONS)("keeps the generic sentence for a private page (%s)", (action) => {
    // A private page is outside `belongsInCommons`, so a deny there is never
    // the realm's. Every deny site read-cloaks before it speaks (DW-270 closed
    // the last half-cloaked one), so this input is unreachable through them —
    // but the resolver must still answer it correctly, because a realm sentence
    // here would tell a caller what kind of page it is, and that it exists.
    for (const kind of REALM_KINDS) {
      expect(
        resolveWriteDenial(action, { visibility: "private" }, kind),
      ).toBe(WRITE_DENIAL[action]);
    }
  });

  it.each(["html", "slides"])(
    "keeps the generic sentence for a public %s artifact",
    (type) => {
      // Artifacts are a person's own rendered output, not collective knowledge:
      // `belongsInCommons` excludes them, so the realm never refuses them and
      // the sentence must not say it did.
      expect(
        resolveWriteDenial("delete", { visibility: "public", type }, "delete"),
      ).toBe(WRITE_DENIAL.delete);
    },
  );

  it.each(["agent-knowledge", "agent-identity"])(
    "keeps the generic sentence for a public %s page",
    (type) => {
      expect(
        resolveWriteDenial("edit", { visibility: "public", type }, "body"),
      ).toBe(WRITE_DENIAL.edit);
    },
  );

  it("keeps the generic sentence when no page was read", () => {
    // The HTTP MCP `reingest` tool and any other surface that denies without a
    // page in hand: nothing was evaluated, so nothing may be claimed.
    expect(resolveWriteDenial("reingest", null, "body")).toBe(
      WRITE_DENIAL.reingest,
    );
    expect(resolveWriteDenial("reingest", undefined, "body")).toBe(
      WRITE_DENIAL.reingest,
    );
  });

  it("ignores non-string frontmatter values rather than trusting them", () => {
    // Frontmatter is parsed YAML: `visibility` can arrive as anything. The
    // coercion mirrors `canWriteFrontmatter`'s, so the sentence and the gate
    // read the same page.
    expect(
      resolveWriteDenial("delete", { visibility: 42, type: {} }, "delete"),
    ).toBe(WRITE_DENIAL_REALM.delete);
  });
});

describe("the resolver and the gate agree on which pages are realm-denied", () => {
  const PAGES = [
    { visibility: "public" },
    { visibility: undefined },
    { visibility: "private" },
    { visibility: "public", type: "html" },
    { visibility: "public", type: "slides" },
    { visibility: "public", type: "agent-knowledge" },
    { visibility: "private", type: "html" },
  ];

  it.each(PAGES)("matches isRealmRestrictedWrite for %o", (meta) => {
    for (const kind of REALM_KINDS) {
      const realm = isRealmRestrictedWrite(meta, kind);
      const sentence = resolveWriteDenial("delete", meta, kind);
      expect(sentence === WRITE_DENIAL_REALM.delete).toBe(realm);
    }
  });

  it("only ever explains a realm on a page a plain user is actually refused", () => {
    // The stronger statement: wherever the realm sentence is emitted, an
    // ordinary signed-in principal really is denied by `canWritePage`. A
    // sentence that appeared where the write would have succeeded would be a
    // refusal nobody received.
    const principal = { id: "user_mallory", handle: "mallory" };
    for (const meta of PAGES) {
      for (const kind of REALM_KINDS) {
        if (resolveWriteDenial("delete", meta, kind) === WRITE_DENIAL_REALM.delete) {
          expect(canWritePage({ owner: "alice", ...meta }, principal, kind)).toBe(
            false,
          );
        }
      }
    }
  });
});

describe("the realm predicate is exhaustive over WriteKind", () => {
  it("answers the same for every kind on a realm page, and never omits one", () => {
    // The predicate is a `switch` with no `default`, so a FOURTH `WriteKind`
    // would be a compile error rather than inheriting the permissive `false` —
    // which is the answer that widens a client gate and drops a realm
    // explanation a caller was owed. TypeScript enforces the exhaustiveness;
    // this records the answer each declared kind gives, so a `default: return
    // false` sneaking back in shows up as a behaviour change here too.
    const realmPage = { visibility: "public" };
    const KINDS: WriteKind[] = ["body", "metadata", "delete"];
    for (const kind of KINDS) {
      expect(isRealmRestrictedWrite(realmPage, kind)).toBe(true);
    }
    // `REALM_KINDS` is what the rest of this file sweeps over; if a kind were
    // added to the type and left off that list, the sweeps would silently stop
    // covering it. Pinned against the same literal list.
    expect([...REALM_KINDS].sort()).toEqual([...KINDS].sort());
  });

  it("still requires writeKind explicitly, and still says false off the realm", () => {
    // The parameter takes no default even though it no longer changes the
    // answer: it is what keeps a future kind-specific rule expressible, and
    // what lets each call site name the write its door was attempting.
    const artifact = { visibility: "public", type: "html" };
    for (const kind of REALM_KINDS) {
      expect(isRealmRestrictedWrite(artifact, kind)).toBe(false);
    }
  });
});

describe("the generic table is the pre-existing wording, unchanged", () => {
  // A non-realm deny must keep reading exactly as it did: these sentences are
  // what `workbench-preview.test.ts` relays and what a caller may already
  // match on.
  it("keeps every generic sentence verbatim", () => {
    expect(WRITE_DENIAL.edit).toBe("You don't have permission to edit this page.");
    expect(WRITE_DENIAL.delete).toBe(
      "You don't have permission to delete this page.",
    );
    expect(WRITE_DENIAL.revert).toBe(
      "You don't have permission to revert this page.",
    );
    expect(WRITE_DENIAL.reingest).toBe(
      "You don't have permission to re-ingest this page.",
    );
    expect(WRITE_DENIAL.bulkDelete).toBe(
      "You don't have permission to delete one or more selected pages.",
    );
  });

  it("gives every action both a generic and a realm sentence", () => {
    // A missing entry would resolve to `undefined` and ship an empty `error`
    // field rather than failing anywhere near the call site.
    for (const action of ACTIONS) {
      expect(typeof WRITE_DENIAL[action]).toBe("string");
      expect(typeof WRITE_DENIAL_REALM[action]).toBe("string");
      expect(WRITE_DENIAL[action]).not.toBe(WRITE_DENIAL_REALM[action]);
    }
  });
});
