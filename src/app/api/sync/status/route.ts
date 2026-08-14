import { NextResponse } from "next/server";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  listLocalSyncClients,
  recordLocalSyncHeartbeat,
  removeLocalSyncClient,
  type LocalSyncClient,
} from "@/lib/local-sync-clients";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  return NextResponse.json({ clients: await listLocalSyncClients(principal.handle) });
}

export async function POST(request: Request) {
  const principal = (await getPrincipal()) ?? getServicePrincipal(request);
  if (!principal) return NextResponse.json({ error: "Valid owner automation token required." }, { status: 401 });
  try {
    const body = await request.json() as {
      clientId?: unknown;
      label?: unknown;
      mode?: unknown;
      operation?: unknown;
      state?: unknown;
      itemCount?: unknown;
      message?: unknown;
    };
    if (typeof body.clientId !== "string" || typeof body.operation !== "string") {
      return NextResponse.json({ error: "clientId and operation are required." }, { status: 400 });
    }
    if (body.mode !== "archive" && body.mode !== "sources") {
      return NextResponse.json({ error: "mode must be archive or sources." }, { status: 400 });
    }
    if (body.state !== "ok" && body.state !== "watching" && body.state !== "failed") {
      return NextResponse.json({ error: "state must be ok, watching, or failed." }, { status: 400 });
    }
    const client = await recordLocalSyncHeartbeat({
      owner: principal.handle,
      clientId: body.clientId,
      label: typeof body.label === "string" ? body.label : undefined,
      mode: body.mode as LocalSyncClient["mode"],
      operation: body.operation,
      state: body.state as LocalSyncClient["state"],
      itemCount: typeof body.itemCount === "number" ? body.itemCount : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
    });
    return NextResponse.json({ client });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    return await removeLocalSyncClient(principal.handle, id)
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Sync client not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}
