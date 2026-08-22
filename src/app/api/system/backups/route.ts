import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { createOwnerBackup, listBackupManifests, summarizeBackup, verifyOwnerBackup } from "@/lib/backups";
import { getErrorMessage } from "@/lib/errors";
import { enqueueTask } from "@/lib/tasks";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    return NextResponse.json({ backups: (await listBackupManifests(principal.handle)).map(summarizeBackup) });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    if (await enqueueTask({ kind: "create-backup", owner: principal.handle })) {
      return NextResponse.json({ queued: true }, { status: 202 });
    }
    // Local development has no Queue binding, so run inline for testability.
    const backup = await createOwnerBackup(principal.handle);
    return NextResponse.json(
      { backup: summarizeBackup(await verifyOwnerBackup(principal.handle, backup.id)) },
      { status: 201 },
    );
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /limit|invalid/i.test(message) ? 400 : 500 },
    );
  }
}
