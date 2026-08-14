"use client";

import { PageError } from "@/components/ErrorBoundary";

export default function GraphError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageError
      title="Graph error"
      description="Something went wrong loading the wiki graph."
      backHref="/"
      backLabel="← Home"
      error={error}
      reset={reset}
    />
  );
}
