"use client";

import { PageError } from "@/components/ErrorBoundary";

export default function NewPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageError
      title="New page error"
      description="Something went wrong creating a new wiki page."
      backHref="/"
      backLabel="← Home"
      error={error}
      reset={reset}
    />
  );
}
