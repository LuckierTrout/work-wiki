import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  deleteSourceMonitor,
  updateSourceMonitor,
  type SourceMonitorCadence,
} from "@/lib/source-monitors";

interface RouteContext { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const monitor = await updateSourceMonitor(principal.handle, id, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(body.cadence === "manual" || body.cadence === "daily" || body.cadence === "weekly"
        ? { cadence: body.cadence as SourceMonitorCadence }
        : {}),
      ...(body.state === "active" || body.state === "paused" ? { state: body.state } : {}),
      ...(typeof body.meaningfulChangeThreshold === "number"
        ? { meaningfulChangeThreshold: body.meaningfulChangeThreshold }
        : {}),
    });
    return monitor
      ? NextResponse.json({ monitor })
      : NextResponse.json({ error: "Monitor not found." }, { status: 404 });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /invalid|required|threshold|state/i.test(message) ? 400 : 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await params;
    return (await deleteSourceMonitor(principal.handle, id))
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Monitor not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
