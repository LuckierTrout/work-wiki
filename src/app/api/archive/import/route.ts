import { NextResponse } from "next/server";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { importPortableArchive, inspectPortableArchive } from "@/lib/portable-archive";

export async function POST(request: Request) {
  const principal = (await getPrincipal()) ?? getServicePrincipal(request);
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const action = new URL(request.url).searchParams.get("action") ?? "preview";
    const collision = new URL(request.url).searchParams.get("collision") === "overwrite" ? "overwrite" : "skip";
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return NextResponse.json({ error: "Archive body is required." }, { status: 400 });
    if (action === "preview") {
      return NextResponse.json({ inspection: await inspectPortableArchive(principal.handle, bytes) });
    }
    if (action !== "import") return NextResponse.json({ error: "Invalid archive action." }, { status: 400 });
    return NextResponse.json({ result: await importPortableArchive(principal.handle, bytes, collision) });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json({ error: message }, { status: /invalid|unsafe|checksum|missing|limit/i.test(message) ? 400 : 500 });
  }
}
