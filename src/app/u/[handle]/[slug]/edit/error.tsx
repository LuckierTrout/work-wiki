"use client";

import { PageError } from "@/components/ErrorBoundary";

export default function EditError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <PageError
      title="Edit error"
      description="Something went wrong while editing this page."
      backHref="/"
      backLabel="← Home"
      error={error}
      reset={reset}
    />
  );
}
