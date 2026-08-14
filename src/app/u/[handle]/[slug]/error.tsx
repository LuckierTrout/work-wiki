"use client";

import { PageError } from "@/components/ErrorBoundary";

export default function WikiPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageError
      title="Page error"
      description="Something went wrong loading this wiki page."
      backHref="/"
      backLabel="← Home"
      error={error}
      reset={reset}
    />
  );
}
