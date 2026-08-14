import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getHermesStatus } from "@/lib/chat";

export async function GET() {
  if (!(await getPrincipal())) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  return NextResponse.json(await getHermesStatus());
}
