import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  createMonitorDigest,
  listMonitorDigests,
  loadMonitorDigestSettings,
  markMonitorDigestQueued,
  saveMonitorDigestSettings,
  type MonitorDigestCadence,
} from "@/lib/monitor-digests";
import { enqueueTask } from "@/lib/tasks";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const [settings, digests] = await Promise.all([
      loadMonitorDigestSettings(principal.handle),
      listMonitorDigests(principal.handle),
    ]);
    return NextResponse.json({
      settings,
      digests,
      unread: digests.filter((digest) => !digest.readAt).length,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (
      typeof body.enabled !== "boolean" ||
      (body.cadence !== "daily" && body.cadence !== "weekly") ||
      typeof body.emailEnabled !== "boolean" ||
      (body.emailAddress !== undefined && typeof body.emailAddress !== "string")
    ) {
      return NextResponse.json(
        { error: "enabled, cadence, emailEnabled, and emailAddress are required." },
        { status: 400 },
      );
    }
    const settings = await saveMonitorDigestSettings(principal.handle, {
      enabled: body.enabled,
      cadence: body.cadence as MonitorDigestCadence,
      emailEnabled: body.emailEnabled,
      emailAddress: typeof body.emailAddress === "string" ? body.emailAddress : "",
    });
    return NextResponse.json({ settings });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /valid|cadence|required/i.test(message) ? 400 : 500 },
    );
  }
}

export async function POST() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const digest = await createMonitorDigest(principal.handle, { force: true });
    if (!digest) {
      return NextResponse.json({
        digest: null,
        queued: false,
        message: "No new source-monitor activity is available for a digest yet.",
      });
    }
    let queued = false;
    let responseDigest = digest;
    if (digest.email.status === "pending" || digest.email.status === "failed") {
      queued = await enqueueTask({
        kind: "deliver-monitor-digest",
        digestId: digest.id,
        owner: principal.handle,
      });
      if (queued) {
        responseDigest = await markMonitorDigestQueued(principal.handle, digest.id) ?? digest;
      }
    }
    return NextResponse.json({
      digest: responseDigest,
      queued,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
