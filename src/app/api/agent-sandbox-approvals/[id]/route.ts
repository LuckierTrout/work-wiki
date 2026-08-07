import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  appendAgentRunArtifacts,
  claimAgentSandboxApproval,
  finishAgentSandboxApproval,
  rejectAgentSandboxApproval,
} from "@/lib/agent-workspaces";
import { runSpecializedAgent } from "@/lib/agent-runtime";
import { executeInSandbox } from "@/lib/sandbox-service";

interface RouteContext { params: Promise<{ id: string }> }

async function resumeAgent(input: {
  agentId: string;
  owner: string;
  message: string;
}) {
  try {
    return {
      activity: await runSpecializedAgent({
        agentId: input.agentId,
        owner: input.owner,
        trigger: "manual",
        prompt: input.message,
      }),
    };
  } catch (error) {
    return { resumeError: getErrorMessage(error) };
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as { decision?: unknown };
    if (body.decision !== "approve" && body.decision !== "reject") {
      return NextResponse.json({ error: "decision must be approve or reject" }, { status: 400 });
    }

    if (body.decision === "reject") {
      const approval = await rejectAgentSandboxApproval(principal.handle, id);
      if (!approval) {
        return NextResponse.json({ error: "Pending approval not found." }, { status: 404 });
      }
      const resumed = await resumeAgent({
        agentId: approval.agentId,
        owner: principal.handle,
        message: `Resume after the owner rejected sandbox command approval ${approval.id}. Do not execute or repeat the rejected command unless the owner explicitly requests a revised approach. Explain what could not be completed and offer a safe alternative.`,
      });
      return NextResponse.json({ approval, ...resumed });
    }

    const claimed = await claimAgentSandboxApproval(principal.handle, id);
    if (!claimed) {
      return NextResponse.json({ error: "Pending approval not found." }, { status: 404 });
    }
    const startedAt = Date.now();
    let approval;
    let resumeMessage;
    try {
      const result = await executeInSandbox({
        runId: claimed.approval.runId,
        command: claimed.approval.command,
        files: claimed.files,
        outputFiles: claimed.approval.outputFiles,
        timeoutMs: claimed.approval.timeoutMs,
      });
      const durationMs = Date.now() - startedAt;
      const log = {
        filename: `sandbox-${claimed.approval.id}.log`,
        mediaType: "text/plain",
        content: `command: ${claimed.approval.command}\nexit: ${result.exitCode}\n\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`,
      };
      await appendAgentRunArtifacts({
        owner: principal.handle,
        agentId: claimed.approval.agentId,
        runId: claimed.approval.runId,
        artifacts: [log, ...(result.artifacts ?? [])],
      });
      approval = await finishAgentSandboxApproval({
        owner: principal.handle,
        id,
        status: result.exitCode === 0 ? "completed" : "failed",
        result: {
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 20_000),
          stderr: result.stderr.slice(0, 10_000),
          artifacts: result.artifacts?.map((artifact) => artifact.filename) ?? [],
          durationMs,
        },
      });
      resumeMessage = `Resume after the owner approved sandbox command ${claimed.approval.id}. The bounded execution finished with exit code ${result.exitCode}.\n\nstdout:\n${result.stdout.slice(0, 20_000)}\n\nstderr:\n${result.stderr.slice(0, 10_000)}\n\nUse only this execution result and the existing owner knowledge to complete the requested continuation.`;
    } catch (error) {
      const message = getErrorMessage(error);
      approval = await finishAgentSandboxApproval({
        owner: principal.handle,
        id,
        status: "failed",
        result: {
          stdout: "",
          stderr: message.slice(0, 10_000),
          artifacts: [],
          durationMs: Date.now() - startedAt,
        },
      });
      resumeMessage = `Resume after sandbox command ${claimed.approval.id} was approved but failed to execute. The failure was: ${message}. Do not claim the command succeeded; explain the limitation and offer the owner a safe next step.`;
    }
    if (!approval) {
      return NextResponse.json({ error: "Approval state changed before completion." }, { status: 409 });
    }
    const resumed = await resumeAgent({
      agentId: approval.agentId,
      owner: principal.handle,
      message: resumeMessage,
    });
    return NextResponse.json({ approval, ...resumed });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
