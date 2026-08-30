import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isOwnerPrincipal } from "@/lib/owner";
import { callLLM, getProviderInfo, hasLLMKey } from "@/lib/llm";
import { getErrorMessage } from "@/lib/errors";

export async function POST() {
  const principal = await getPrincipal();
  if (!isOwnerPrincipal(principal)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // No `loadConfig()` warm ahead of the gate any more (DW-548). The gate below
  // reads the store itself now, so a warm here bought a SECOND full storage
  // round-trip per request — and a window between the two reads in which the
  // answer could change. The gate's own read is the one snapshot.
  if (!(await hasLLMKey())) {
    return NextResponse.json(
      { error: "No provider credential is configured on the server." },
      { status: 400 },
    );
  }

  try {
    await callLLM(
      "You are a connection test. Follow the user's response format exactly.",
      "Reply with only the word OK.",
      { maxOutputTokens: 8 },
    );
    return NextResponse.json({ ok: true, ...getProviderInfo() });
  } catch (error) {
    return NextResponse.json(
      { error: getErrorMessage(error, "Provider connection failed") },
      { status: 502 },
    );
  }
}
