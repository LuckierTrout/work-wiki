import Link from "next/link";

export default function WikiPageNotFound() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-bold">Page not found</h1>
      <p className="mt-4 text-foreground/60">
        This wiki page doesn&apos;t exist. Check the slug spelling, or{" "}
        <Link href="/ingest" className="underline hover:text-foreground">
          ingest a new source
        </Link>{" "}
        to create it.
      </p>
    </div>
  );
}
