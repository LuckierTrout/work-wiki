import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { effectiveStatus, listIngestJobs } from "@/lib/ingest-jobs";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const source = searchParams.get("source");
    if (source !== null && source !== "email") {
      return NextResponse.json(
        { error: "source must be email when provided" },
        { status: 400 },
      );
    }
    const rawLimit = searchParams.get("limit");
    const limit = rawLimit === null ? 20 : Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return NextResponse.json(
        { error: "limit must be between 1 and 100" },
        { status: 400 },
      );
    }

    const jobs = await listIngestJobs({
      owner: principal.handle,
      ...(source === "email" ? { source: "email" as const } : {}),
      limit,
    });
    return NextResponse.json({
      jobs: jobs.map((job) => {
        const effective = effectiveStatus(job);
        return {
          ...job,
          status: effective.status,
          ...(effective.error ? { error: effective.error } : {}),
        };
      }),
    });
  } catch (error) {
    logger.error("ingest-jobs", "job list failed", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
