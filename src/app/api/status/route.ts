import { getProviderInfo } from "@/lib/llm";
import { readConfig } from "@/lib/config";
import type { ProviderInfo } from "@/lib/types";

/**
 * What `GET /api/status` serves: a whole {@link ProviderInfo}, plus the one
 * READ-TIME fact the resolver cannot know (DW-622).
 *
 * WHY THE FLAG IS ROUTE-LOCAL AND NOT ON `ProviderInfo`. `getProviderInfo()` is
 * synchronous over the config cache and has no idea how the last read went — and
 * `POST /api/settings/test` spreads a whole `ProviderInfo` without performing a
 * config read at all, so putting the field on the shared type would force one of
 * its two producers to GUESS at it. The catch branch below already sets the
 * precedent for a field this endpoint adds beside `ProviderInfo` rather than
 * inside it. A Next `route.ts` may export nothing but its HTTP verbs, so this is
 * a local, non-exported `type`.
 *
 * WHY IT IS A BOOLEAN AND CARRIES NO DETAIL. The store holds `customApiKey`,
 * `embeddingApiKey` and `firecrawlApiKey`, and V8's `JSON.parse` message quotes
 * the offending bytes straight back — so a parser string on this body is a route
 * that can serve secret material to anyone who can reach it (AD-23, the same
 * rule that keeps the R2 etag internal). The detail an operator needs is already
 * `logger.warn`-ed inside `readStoredConfig`, and the CLI's `status` command
 * prints it on the local surface where it is safe to. This body says only THAT
 * the store could not be read.
 *
 * AND YES, THIS IS A READ THAT SAYS SOMETHING ABOUT HOW A READ WENT.
 * `CONFIG_UNREADABLE_COPY`'s docblock states the opposite as a rule — a read
 * must grant no oracle, and a body telling its reader which way the read failed
 * would be one — so the tension is named here rather than left for someone to
 * find. That rule is about the SETTINGS read, whose two clients deliberately
 * flatten every non-ok answer to one fixed string, and it is about DETAIL: an
 * anonymous caller learning which of several failures occurred. Neither applies
 * here. The fact IS the product of this endpoint — a status door whose whole job
 * is to say what is and is not in force — it is a single boolean with no error,
 * no path and no bytes behind it, and every request that reaches this route has
 * already passed the same owner gate as the rest of the deployment
 * (`src/middleware.ts`). There is no reader of this flag who is not the owner.
 */
type StatusBody = ProviderInfo & { configUnreadable: boolean };

export async function GET() {
  // Reported on BOTH bodies, so the 500 below is as honest about the read as the
  // 200 is — the read happens first and its answer survives a throwing resolver.
  //
  // OPTIMISTIC ABOUT NOTHING: it starts TRUE and is overwritten by a read that
  // actually answered. `readConfig()` returns its failures rather than throwing,
  // so an await that rejects here is a case nothing can currently produce — but
  // it is the one case where the store's state is UNKNOWN, and "unknown"
  // reported as "clean" is the exact conflation this whole change removes. This
  // way the unreachable path is inert rather than wrong.
  let configUnreadable = true;
  try {
    // THROUGH `readConfig()` RATHER THAN `loadConfig()` (DW-549's move, on the
    // web side). This is still ONE read and one round-trip — the DW-502 warm
    // this route exists to perform, priming the sync cache identically before
    // `getProviderInfo()` reads it — but `loadConfig()` flattens an UNREADABLE
    // store to `{}`, so a config that exists and could not be parsed was served
    // exactly like one that was never saved. `readConfig()` RETURNS that failure
    // rather than throwing, which is why it sits inside the existing `try`
    // without changing what the catch branch means.
    const read = await readConfig();
    configUnreadable = read.status !== "ok";
    const info = getProviderInfo();
    return Response.json({ ...info, configUnreadable } satisfies StatusBody);
  } catch (err) {
    return Response.json(
      // A COMPLETE `ProviderInfo`, error field aside: this body is the shape
      // the client asserts, and the endpoint ladder never ran here, so it
      // refused nothing there is anything to say about (DW-402).
      //
      // `satisfies` rather than a comment alone: this literal hand-duplicates a
      // type it does not otherwise reference, so without the check the NEXT
      // field added to `ProviderInfo` compiles here as a silently partial body
      // — which is exactly how this branch came to be missing one.
      {
        configured: false,
        provider: null,
        model: null,
        embeddingSupport: false,
        ollamaBaseUrlIssue: null,
        configUnreadable,
        error: String(err),
      } satisfies StatusBody & { error: string },
      { status: 500 }
    );
  }
}
