import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { buildPortableArchive } from "@/lib/portable-archive";

export async function GET(request: Request) {
  const principal = (await getPrincipal()) ?? getServicePrincipal(request);
  if (!principal) return Response.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { manifest, bytes } = await buildPortableArchive(principal.handle);
    const date = manifest.createdAt.slice(0, 10);
    return new Response(bytesBuffer(bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="workwiki-${date}.zip"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
