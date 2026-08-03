import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { summarizeBackup, verifyOwnerBackup } from "@/lib/backups";
import { getErrorMessage } from "@/lib/errors";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await context.params;
    return NextResponse.json({ backup: summarizeBackup(await verifyOwnerBackup(principal.handle, id)) });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /not found/i.test(message) ? 404 : /invalid/i.test(message) ? 400 : 500 },
    );
  }
}
