import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";
import { callLLM, getProviderInfo, hasLLMKey } from "@/lib/llm";
import { getErrorMessage } from "@/lib/errors";
import { loadConfig } from "@/lib/config";

export async function POST() {
  const principal = await getPrincipal();
  if (!isOwnerHandle(principal?.handle)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await loadConfig();
  if (!hasLLMKey()) {
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
