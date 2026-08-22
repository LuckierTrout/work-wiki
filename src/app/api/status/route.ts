import { getProviderInfo } from "@/lib/llm";
import { loadConfig } from "@/lib/config";
import type { ProviderInfo } from "@/lib/types";

export async function GET() {
  try {
    await loadConfig();
    const info = getProviderInfo();
    return Response.json(info);
  } catch (err) {
    return Response.json(
      // A COMPLETE `ProviderInfo`, error field aside: this body is the shape
      // the client asserts, and the endpoint ladder never ran here, so it
      // refused nothing there is anything to say about (DW-402).
      //
      // `satisfies` rather than a comment alone: this literal hand-duplicates a
      // type it does not otherwise reference, so without the check the NEXT
      // field added to `ProviderInfo` compiles here as a silently partial body
      // — which is exactly how this branch came to be missing one.
      {
        configured: false,
        provider: null,
        model: null,
        embeddingSupport: false,
        ollamaBaseUrlIssue: null,
        error: String(err),
      } satisfies ProviderInfo & { error: string },
      { status: 500 }
    );
  }
}
