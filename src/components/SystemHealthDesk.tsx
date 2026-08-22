"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Alert } from "@/components/Alert";
import { backupTruncationCopy, type BackupSummary } from "@/lib/backups";
import type { RetrievalEvalCase, RetrievalEvalRun } from "@/lib/retrieval-evals";
import type { SystemHealthSnapshot } from "@/lib/system-health";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function percentage(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function compactDate(value: string | undefined): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function SystemHealthDesk() {
  const [health, setHealth] = useState<SystemHealthSnapshot | null>(null);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [cases, setCases] = useState<RetrievalEvalCase[]>([]);
  const [runs, setRuns] = useState<RetrievalEvalRun[]>([]);
  const [label, setLabel] = useState("");
  const [question, setQuestion] = useState("");
  const [expectedSlugs, setExpectedSlugs] = useState("");
  const [forbiddenSlugs, setForbiddenSlugs] = useState("");
  const [requiredPhrases, setRequiredPhrases] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthData, backupData, evaluationData] = await Promise.all([
        request<{ health: SystemHealthSnapshot }>("/api/system/health"),
        request<{ backups: BackupSummary[] }>("/api/system/backups"),
        request<{ cases: RetrievalEvalCase[]; runs: RetrievalEvalRun[] }>("/api/system/evaluations"),
      ]);
      setHealth(healthData.health);
      setBackups(backupData.backups);
      setCases(evaluationData.cases);
      setRuns(evaluationData.runs);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load system health.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createBackup() {
    setBusy("backup");
    setError(null);
    setNotice(null);
    try {
      const data = await request<{ backup?: BackupSummary; queued?: boolean }>("/api/system/backups", { method: "POST" });
      const completed = data.backup;
      if (completed) {
        setBackups((current) => [completed, ...current.filter((item) => item.id !== completed.id)]);
        // A truncated backup verifies like any other, so the "passed" branch
        // alone would report a partial snapshot as a whole one at the exact
        // moment the owner is watching for a receipt.
        setNotice(completed.verificationStatus !== "passed"
          ? "Backup created, but restore verification needs attention."
          : completed.truncated?.length
            ? `Backup created and verified, but it covered only part of your data — ${backupTruncationCopy(completed.truncated)}.`
            : "Backup created and restored successfully in the isolated verification area.");
        await load();
      } else {
        setNotice("Backup and isolated restore verification are queued. The receipt will appear here when processing finishes.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the backup.");
    } finally {
      setBusy(null);
    }
  }

  async function verifyBackup(id: string) {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      const data = await request<{ backup: BackupSummary }>(`/api/system/backups/${id}/verify`, { method: "POST" });
      setBackups((current) => current.map((item) => item.id === id ? data.backup : item));
      setNotice(data.backup.verificationStatus === "passed"
        ? "Restore verification passed. Production data was not altered."
        : "Restore verification failed. Review the receipt below.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not verify the backup.");
    } finally {
      setBusy(null);
    }
  }

  async function saveCase(event: React.FormEvent) {
    event.preventDefault();
    setBusy("case");
    setError(null);
    setNotice(null);
    try {
      const data = await request<{ case: RetrievalEvalCase }>("/api/system/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          question,
          expectedSlugs: splitList(expectedSlugs),
          forbiddenSlugs: splitList(forbiddenSlugs),
          requiredPhrases: splitList(requiredPhrases),
        }),
      });
      setCases((current) => [...current, data.case]);
      setLabel("");
      setQuestion("");
      setExpectedSlugs("");
      setForbiddenSlugs("");
      setRequiredPhrases("");
      setNotice("Retrieval check saved. Run the suite when you are ready to spend a model call per case.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the evaluation case.");
    } finally {
      setBusy(null);
    }
  }

  async function runEvaluation() {
    setBusy("evaluation");
    setError(null);
    setNotice(null);
    try {
      const data = await request<{ run: RetrievalEvalRun }>("/api/system/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      });
      setRuns((current) => [data.run, ...current]);
      setNotice("Retrieval evaluation complete. Results are stored as an auditable run.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not run the evaluation suite.");
    } finally {
      setBusy(null);
    }
  }

  async function removeCase(id: string) {
    setBusy(id);
    setError(null);
    try {
      await request<{ deleted: boolean }>(`/api/system/evaluations/${id}`, { method: "DELETE" });
      setCases((current) => current.filter((item) => item.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove the evaluation case.");
    } finally {
      setBusy(null);
    }
  }

  const latestRun = runs[0];
  const attention = health?.status === "attention";

  return (
    <div className="shell paper-route fade" style={{ paddingTop: 46, paddingBottom: 92 }}>
      <div className="spread" style={{ gap: 24, alignItems: "end" }}>
        <div>
          <p className="fmark" style={{ marginBottom: 16 }}>operator&apos;s desk</p>
          <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>
            Memory you can inspect and trust.
          </h1>
          <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 0", maxWidth: "66ch" }}>
            Evidence, delivery, retrieval, cost, and recovery signals in one owner-only view.
          </p>
        </div>
        <span className="receipt" style={{ color: attention ? "var(--rust)" : "var(--accent)", fontSize: 11 }}>
          {loading ? "CHECKING" : attention ? "ATTENTION NEEDED" : "SYSTEM HEALTHY"}
        </span>
      </div>

      {error && <div style={{ marginTop: 20 }}><Alert variant="error">{error}</Alert></div>}
      {notice && <div style={{ marginTop: 20 }}><Alert variant="success">{notice}</Alert></div>}

      <section className="grid sm:grid-cols-2 lg:grid-cols-4" style={{ gap: 13, marginTop: 30 }} aria-label="System summary">
        <HealthCard label="source checks" value={health ? String(health.monitors.failed) : "—"} detail={`${health?.monitors.total ?? 0} monitored · ${health?.monitors.active ?? 0} active`} bad={Boolean(health?.monitors.failed)} />
        <HealthCard label="delivery failures" value={health ? String(health.integrations.failed) : "—"} detail={`${health?.integrations.pending ?? 0} in flight · ${health?.integrations.delivered ?? 0} delivered`} bad={Boolean(health?.integrations.failed)} />
        {/* `backup.status` stays "verified" for a truncated backup — verification
            and coverage are different questions — so truncation has to be folded
            in here explicitly, or this card reads green while the page banner
            says attention needed. */}
        <HealthCard label="restore check" value={health?.backup.status ?? "—"} detail={health?.backup.latest ? (backupTruncationCopy(health.backup.latest.truncated) || compactDate(health.backup.latest.verifiedAt)) : "No backup recorded"} bad={health?.backup.status !== "verified" || Boolean(health?.backup.latest?.truncated?.length)} />
        <HealthCard label="privacy eval" value={health?.evaluation.privacyPass === null || health?.evaluation.privacyPass === undefined ? "not run" : health.evaluation.privacyPass ? "passed" : "failed"} detail={health?.evaluation.latest ? `${health.evaluation.latest.caseCount} cases` : "Add a golden question below"} bad={health?.evaluation.privacyPass === false} />
      </section>

      <section className="grid lg:grid-cols-[0.9fr_1.1fr]" style={{ gap: 24, marginTop: 38 }}>
        <div style={panel}>
          <div className="spread" style={{ gap: 16 }}>
            <div><p className="fmark">recovery</p><h2 className="display" style={heading}>Verified backups</h2></div>
            <button className="btn primary" type="button" onClick={() => void createBackup()} disabled={busy !== null}>{busy === "backup" ? "Backing up…" : "Create + verify"}</button>
          </div>
          <p style={bodyCopy}>Snapshots copy your owner silo byte-for-byte, then restore it into a disposable isolated path and compare checksums. This never overwrites live data.</p>
          <div style={{ marginTop: 18 }}>
            {backups.length === 0 ? <Empty>No backups yet.</Empty> : backups.slice(0, 6).map((backup) => (
              <article key={backup.id} className="spread" style={rowStyle}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <span className="receipt" style={{ ...micro, color: backup.verificationStatus === "passed" ? "var(--accent)" : backup.verificationStatus === "failed" ? "var(--rust)" : "var(--muted)" }}>{backup.verificationStatus ?? "unverified"}</span>
                    <strong style={{ fontSize: 13.5 }}>{compactDate(backup.createdAt)}</strong>
                  </div>
                  {/* A partial backup verifies exactly like a complete one — it
                      checks the entries its manifest holds — so without this the
                      row would read as a clean full snapshot of the tenant. */}
                  <p className="receipt" style={{ ...micro, margin: "6px 0 0" }}>{backup.fileCount} files · {sizeLabel(backup.totalBytes)}{backup.truncated?.length ? <> · <span style={{ color: "var(--rust)" }}>{backupTruncationCopy(backup.truncated)}</span></> : null}</p>
                  {backup.verificationError && <p style={{ color: "var(--rust)", fontSize: 12, margin: "6px 0 0" }}>{backup.verificationError}</p>}
                </div>
                <button className="btn ghost" type="button" onClick={() => void verifyBackup(backup.id)} disabled={busy !== null}>{busy === backup.id ? "Checking…" : "Verify"}</button>
              </article>
            ))}
          </div>
        </div>

        <div style={panel}>
          <div className="spread" style={{ gap: 16 }}>
            <div><p className="fmark">retrieval evaluation</p><h2 className="display" style={heading}>Golden-question suite</h2></div>
            <button className="btn primary" type="button" onClick={() => void runEvaluation()} disabled={busy !== null || cases.length === 0}>{busy === "evaluation" ? "Evaluating…" : "Run suite"}</button>
          </div>
          <p style={bodyCopy}>Check whether Ask retrieves the right pages, avoids forbidden pages, and uses required language. Each case uses one live model call.</p>
          <div className="grid grid-cols-2 sm:grid-cols-4" style={{ gap: 9, marginTop: 17 }}>
            <Metric label="source recall" value={percentage(latestRun?.sourceRecall)} />
            <Metric label="citation precision" value={percentage(latestRun?.citationPrecision)} />
            <Metric label="privacy" value={percentage(latestRun?.privacyPassRate)} />
            <Metric label="grounded" value={percentage(latestRun?.groundedAnswerRate)} />
          </div>
          <p className="receipt" style={{ ...micro, margin: "13px 0 0" }}>{latestRun ? `LAST RUN ${compactDate(latestRun.createdAt).toUpperCase()}` : "NO STORED RUNS"}</p>
        </div>
      </section>

      <section className="grid lg:grid-cols-[1fr_1fr]" style={{ gap: 24, marginTop: 24 }}>
        <form onSubmit={saveCase} style={panel}>
          <p className="fmark">new quality check</p>
          <h2 className="display" style={heading}>Teach work-wiki what good looks like.</h2>
          <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
            <Field label="Label"><input required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Project status answer" style={inputStyle} /></Field>
            <Field label="Question"><textarea required value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What decisions changed this week?" rows={3} style={{ ...inputStyle, resize: "vertical" }} /></Field>
            <Field label="Expected page slugs, comma separated"><input value={expectedSlugs} onChange={(event) => setExpectedSlugs(event.target.value)} placeholder="project-status, decision-log" style={inputStyle} /></Field>
            <Field label="Forbidden page slugs, comma separated"><input value={forbiddenSlugs} onChange={(event) => setForbiddenSlugs(event.target.value)} placeholder="another-owner-private-page" style={inputStyle} /></Field>
            <Field label="Required phrases, comma separated"><input value={requiredPhrases} onChange={(event) => setRequiredPhrases(event.target.value)} placeholder="conflict, unresolved" style={inputStyle} /></Field>
          </div>
          <div className="row" style={{ justifyContent: "end", marginTop: 14 }}><button className="btn primary" type="submit" disabled={busy !== null}>{busy === "case" ? "Saving…" : "Save check"}</button></div>
        </form>

        <div style={panel}>
          <div className="spread" style={{ gap: 12 }}><div><p className="fmark">test corpus</p><h2 className="display" style={heading}>Saved checks</h2></div><span className="receipt" style={micro}>{cases.length} cases</span></div>
          <div style={{ marginTop: 13 }}>
            {cases.length === 0 ? <Empty>No checks yet. Start with one question you already know the answer to.</Empty> : cases.map((item) => (
              <article key={item.id} style={rowStyle}>
                <div className="spread" style={{ gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: "block", fontSize: 14 }}>{item.label}</strong>
                    <p style={{ color: "var(--ink-2)", fontSize: 13, lineHeight: 1.5, margin: "5px 0" }}>{item.question}</p>
                    <p className="receipt" style={{ ...micro, margin: 0 }}>EXPECT {item.expectedSlugs.join(", ") || "explicit insufficiency"}</p>
                  </div>
                  <button className="btn ghost" type="button" onClick={() => void removeCase(item.id)} disabled={busy !== null}>Remove</button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section style={{ marginTop: 40 }}>
        <div className="spread" style={{ gap: 16, borderBottom: "1px solid var(--rule)", paddingBottom: 13 }}>
          <div><p className="fmark">operation ledger</p><h2 className="display" style={heading}>Receipts, cost, and failures</h2></div>
          <div className="row" style={{ gap: 17 }}>
            <span className="receipt" style={micro}>{health?.operations.inputTokens.toLocaleString() ?? 0} input tokens</span>
            <span className="receipt" style={micro}>{health?.operations.estimatedCostUsd === null || health?.operations.estimatedCostUsd === undefined ? "cost rates not configured" : `$${health.operations.estimatedCostUsd.toFixed(4)} estimated`}</span>
          </div>
        </div>
        {!health?.operations.recent.length ? <Empty>No operation receipts yet.</Empty> : health.operations.recent.map((operation) => (
          <article key={operation.id} className="grid sm:grid-cols-[130px_1fr_auto]" style={{ gap: 14, padding: "14px 0", borderBottom: "1px solid var(--rule)", alignItems: "start" }}>
            <span className="receipt" style={{ ...micro, color: operation.status === "failed" ? "var(--rust)" : "var(--accent)" }}>{operation.kind} · {operation.status}</span>
            <div><strong style={{ display: "block", fontSize: 13.5 }}>{operation.operation}</strong>{operation.detail && <p style={{ color: "var(--muted)", fontSize: 12.5, margin: "4px 0 0" }}>{operation.detail}</p>}</div>
            <span className="receipt" style={{ ...micro, textAlign: "right" }}>{compactDate(operation.createdAt)}</span>
          </article>
        ))}
      </section>

      <aside style={{ ...panel, marginTop: 30, display: "grid", gap: 8 }}>
        <p className="fmark">deployment boundary</p>
        <p style={{ ...bodyCopy, margin: 0 }}>{health?.queue.note ?? "Queue telemetry is checked in Cloudflare."}</p>
        <p style={{ ...bodyCopy, margin: 0 }}>Dead-letter queue depth is provider telemetry, while work-wiki keeps owner-visible operation and retry receipts. <Link href="/integrations" className="underline">Inspect integrations</Link> or <Link href="/review" className="underline">open the Review Desk</Link>.</p>
      </aside>
    </div>
  );
}

function HealthCard({ label, value, detail, bad }: { label: string; value: string; detail: string; bad: boolean }) {
  return <div style={card}><p className="fmark">{label}</p><strong className="display" style={{ display: "block", color: bad ? "var(--rust)" : "var(--ink)", fontSize: 30, marginTop: 9, textTransform: "capitalize" }}>{value}</strong><p style={{ ...bodyCopy, fontSize: 12.5, marginBottom: 0 }}>{detail}</p></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: 10, padding: "12px 10px" }}><strong className="display" style={{ display: "block", fontSize: 21 }}>{value}</strong><span className="receipt" style={{ ...micro, display: "block", marginTop: 4 }}>{label}</span></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "grid", gap: 6, color: "var(--muted)", fontSize: 12 }}>{label}{children}</label>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "var(--muted)", fontSize: 13.5, padding: "16px 0", margin: 0 }}>{children}</p>;
}

const panel: CSSProperties = { padding: 21, background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: 14 };
const card: CSSProperties = { padding: 17, background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: 12 };
const heading: CSSProperties = { fontSize: 25, margin: "8px 0 0" };
const bodyCopy: CSSProperties = { color: "var(--muted)", fontSize: 13.5, lineHeight: 1.55 };
const micro: CSSProperties = { color: "var(--faint)", fontSize: 9.5, textTransform: "uppercase" };
const rowStyle: CSSProperties = { padding: "14px 0", borderBottom: "1px solid var(--rule)" };
const inputStyle: CSSProperties = { width: "100%", border: "1px solid var(--rule-strong)", borderRadius: 9, background: "var(--paper)", color: "var(--ink)", padding: "10px 12px", font: "inherit", fontSize: 14 };
