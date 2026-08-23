import { NextResponse } from "next/server";

/** `/chat` alias — cloud Chat is sidecar-only. */
export async function POST() {
  return NextResponse.json({ error: "sidecar_required" }, { status: 503 });
}
