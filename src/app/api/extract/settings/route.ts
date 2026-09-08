import { NextRequest, NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { resolveExtractCaller } from "@/lib/extract-auth";
import { getIntakeSettings, getMinerUExtractorConfig } from "@/lib/extract-settings";
import { logger } from "@/lib/logger";

/**
 * `GET /api/extract/settings` — what the claim loop needs to know before it
 * parses anything (Stories 7.2 / 7.5).
 *
 * THE MINERU KEY IS IN THIS ANSWER, and this is the only door it leaves by.
 * The sidecar is the process that would make the MinerU call — the Worker has
 * no document to send and cannot reach a local API server — so the credential
 * has to travel to it. It travels no further than the bytes of the document
 * already do, over the same owner-automation token, to the same loopback
 * process.
 *
 * SERVICE ONLY, for that reason. A Clerk session gets 403 rather than a
 * redacted answer: the pane already has its own read (`getMinerUSettings`,
 * which reports whether a key exists and never what it is), and a second
 * browser-reachable shape of the same settings is how the redaction gets
 * dropped in a later edit.
 *
 * "Settings apply only after Save" falls out of reading them HERE rather than
 * caching them in the sidecar: the loop asks once per drain, so a Save lands
 * on the next document and an unsaved Cloud selection never lands at all.
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const caller = await resolveExtractCaller(request, url.searchParams.get("owner"));
    if (!caller) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!caller.service) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const [mineru, intake] = await Promise.all([
      getMinerUExtractorConfig(),
      getIntakeSettings(),
    ]);
    return NextResponse.json({
      mineru,
      keepParsed: intake.keepParsed,
    });
  } catch (error) {
    logger.error("extract", "extract settings door failed", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
