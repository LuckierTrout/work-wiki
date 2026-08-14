import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  createSourceMonitor,
  listSourceMonitors,
  type SourceMonitorCadence,
} from "@/lib/source-monitors";

const CADENCES = new Set<SourceMonitorCadence>(["manual", "daily", "weekly"]);

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    return NextResponse.json({ monitors: await listSourceMonitors(principal.handle) });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (
      typeof body.name !== "string" ||
      typeof body.url !== "string" ||
      typeof body.targetSlug !== "string"
    ) {
      return NextResponse.json({ error: "name, url, and targetSlug are required." }, { status: 400 });
    }
    if (body.cadence !== undefined && !CADENCES.has(body.cadence as SourceMonitorCadence)) {
      return NextResponse.json({ error: "cadence must be manual, daily, or weekly." }, { status: 400 });
    }
    const monitor = await createSourceMonitor(principal.handle, {
      name: body.name,
      url: body.url,
      targetSlug: body.targetSlug,
      ...(CADENCES.has(body.cadence as SourceMonitorCadence)
        ? { cadence: body.cadence as SourceMonitorCadence }
        : {}),
      ...(typeof body.meaningfulChangeThreshold === "number"
        ? { meaningfulChangeThreshold: body.meaningfulChangeThreshold }
        : {}),
    });
    return NextResponse.json({ monitor }, { status: 201 });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /required|invalid|blocked|threshold|at most/i.test(message) ? 400 : 500 },
    );
  }
}
