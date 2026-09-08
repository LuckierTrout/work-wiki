import Link from "next/link";

export default function RawSourceNotFound() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-bold">Source not found</h1>
      <p className="mt-4 text-foreground/60">
        This page has no stored raw source, or the slug is wrong. You can{" "}
        <Link href="/ingest" className="underline hover:text-foreground">
          ingest a new source
        </Link>
        .
      </p>
    </div>
  );
}
