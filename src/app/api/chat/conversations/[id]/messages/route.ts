import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { addChatTurn } from "@/lib/chat";
import { getErrorMessage } from "@/lib/errors";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = (await request.json()) as { message?: unknown };
    if (typeof body.message !== "string" || !body.message.trim()) {
      return NextResponse.json(
        { error: "message is required and must be a non-empty string" },
        { status: 400 },
      );
    }
    return NextResponse.json(
      await addChatTurn(principal.handle, id, body.message, principal),
    );
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /not found/i.test(message) ? 404 : /cannot be empty/i.test(message) ? 400 : 500 },
    );
  }
}
