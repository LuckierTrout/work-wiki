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
    // `invalid` is `validateBackupId`'s "Invalid backup id" — a caller fault, so
    // 400. `limit` used to sit here for the two "Backup exceeds the … safety
    // limit" throws; since DW-215 a backup DEGRADES at those limits and returns
    // 201 with a flagged manifest, so the pattern matched nothing this route can
    // still raise and only invited a future 500 to be mislabelled a 400.
    return NextResponse.json(
      { error: message },
      { status: /invalid/i.test(message) ? 400 : 500 },
    );
  }
}
