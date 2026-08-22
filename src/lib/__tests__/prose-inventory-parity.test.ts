import { readFile } from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_FORMAT_LABELS } from "../document-extract";
import { MAINTAIN_FIX_TYPES, TASK_KINDS } from "../tasks";
import { AUTO_FIXABLE_CHECK_TYPES } from "../lint-types";
import { createMcpServer } from "../../mcp";

/**
 * Nine hand-written prose inventories restate a machine list, and nothing in
 * the source can pin any of them (DW-132, DW-249, DW-341, DW-343, DW-346). The
 * nine, across eight files, by kind:
 *
 *   - `src/mcp.ts` — a JSDoc header comment listing every MCP tool;
 *   - `src/lib/maintenance.ts` — a module-header JSDoc listing every
 *     `MaintainFixType`;
 *   - `src/app/api/lint/fix/route.ts` — a route JSDoc listing every
 *     auto-fixable check type;
 *   - `workers/task-consumer/README.md` and `workers/email-ingest/README.md` —
 *     two Markdown READMEs (the task-consumer one carries TWO inventories: the
 *     `Task` kinds and the `MaintainFixType` union);
 *   - `workers/email-ingest/index.ts` — a Cloudflare Worker's auto-reply string;
 *   - `src/components/EmailIngestSettings.tsx` — a JSX bullet in the UI;
 *   - `src/app/api/ingest/document/route.ts` — a runtime API error message.
 *
 * Only three of them could import a generated sentence from `src/lib`; the rest
 * cannot (a comment and two Markdown files are not code, and the Worker bundle
 * cannot reach `src/lib` at all). Generating at three of nine sites would leave
 * six unpinned AND split this into two conventions, so the convention here is
 * the one that reaches all nine: READ the prose back out of the file, tokenize
 * it, and compare the token set to a set DERIVED from the code.
 *
 * Every machine side below is derived (`DOCUMENT_FORMAT_LABELS`, `TASK_KINDS`,
 * `MAINTAIN_FIX_TYPES`, `AUTO_FIXABLE_CHECK_TYPES`, the MCP server's
 * registered-tool map), never a literal restated in this file: a restated
 * literal would have to be edited alongside the very change it is supposed to
 * catch, and would therefore never fail.
 *
 * What this buys, stated honestly: read-back pins that the lists AGREE — it
 * does not reduce the number of edits. Adding a document format still means
 * editing `DOCUMENT_FORMATS`, `DOCUMENT_FORMAT_LABELS`, and all four sentences;
 * adding a ninth `MaintainFixType` still means editing the union, the
 * `MAINTAIN_FIX_TYPES` tuple, and both sentences that restate it.
 * What changes is that you can no longer *forget* one: `tsc` stops you at the
 * label map (and at `_NoMaintainFixTypeMissingFromList`), and this suite names
 * each sentence you missed.
 *
 * Note the format sites compare against `DOCUMENT_FORMATS`-derived labels, not
 * against `SUPPORTED_DOCUMENT_EXTENSIONS` (which is what the ledger entry
 * named). That is deliberate: the extension list also carries the
 * `EXTENSION_ALIASES` keys `markdown` and `htm`, which no sentence names and
 * none should — they fold into "Markdown" and "HTML". The alias set stays
 * pinned by `email-ingest-allowlist-parity.test.ts`.
 *
 * Comparisons run in BOTH directions — a prose entry with no machine
 * counterpart (a retired tool still listed in the header) fails just as loudly
 * as a machine entry with no prose counterpart, and both are reported by a
 * single run so a two-sided drift is one fix, not two.
 *
 * The extractors are anchor-based on purpose. An anchor that stops matching
 * because the prose was reworded, or that starts matching twice, is a hard
 * failure naming the file — never an empty or wrong token set that compares
 * equal to nothing.
 */

const repoFile = (relative: string) =>
  path.resolve(__dirname, "../../..", relative);

/**
 * Strip comment gutters (`src/mcp.ts`'s header and the Worker sources are
 * JSDoc) while keeping line structure. The pattern deliberately skips `**`, so
 * Markdown bold at the start of a README line survives intact.
 */
async function readSourceLines(relativePath: string): Promise<string[]> {
  const text = await readFile(repoFile(relativePath), "utf8");
  return text.replace(/^[ \t]*\*(?!\*)[ \t]?/gm, "").split("\n");
}

/**
 * The same text as one flat line, for the sentences that wrap across source
 * lines — every prose sentence pinned here does.
 */
async function readProse(relativePath: string): Promise<string> {
  return (await readSourceLines(relativePath)).join(" ").replace(/\s+/g, " ");
}

/**
 * Pull the inventory out of `text` with `anchor` (one capture group), or throw
 * naming the file.
 *
 * The anchor must match EXACTLY once. First-match-wins would be a live hazard:
 * `workers/email-ingest/index.ts:94` says "Supported attachments forwarded from
 * one email." — one colon away from being extracted instead of the real reply
 * string 150 lines below it. A second match is as wrong as none, and neither
 * may pass silently.
 */
function extract(
  text: string,
  anchor: RegExp,
  file: string,
  what = "format sentence",
): string {
  const flags = anchor.flags.includes("g") ? anchor.flags : `${anchor.flags}g`;
  const matches = [...text.matchAll(new RegExp(anchor.source, flags))];
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `no ${what} found in ${file} — ${String(anchor)} no longer matches, ` +
          `so this inventory is unpinned until the anchor is repaired`
        : `ambiguous ${what} in ${file} — ${String(anchor)} matches ` +
          `${matches.length} times, so the wrong one could be pinned`,
    );
  }
  const captured = matches[0][1]?.trim();
  if (!captured) {
    throw new Error(
      `no ${what} found in ${file} — ${String(anchor)} matched but captured ` +
        `nothing, which would compare equal to any machine list`,
    );
  }
  return captured;
}

/**
 * The lines strictly between the one matching `from` and the next one matching
 * `to`, or throw naming the file. `to` may be derived from the opening line —
 * the dispatch switch closes at a brace on its OWN indentation, which is what
 * stops the capture running past the end of the switch.
 *
 * Line-based, so a marker is only recognised where it starts a line: a
 * description that happens to contain "Usage:" cannot end the MCP tool block
 * early, and `from` matching twice is an error rather than a coin flip.
 */
function extractBlock(
  lines: readonly string[],
  from: RegExp,
  to: RegExp | ((openingLine: string) => RegExp),
  file: string,
  what: string,
): string[] {
  const opens = lines.filter((line) => from.test(line));
  if (opens.length !== 1) {
    throw new Error(
      opens.length === 0
        ? `no ${what} found in ${file} — ${String(from)} no longer matches, ` +
          `so this inventory is unpinned until the anchor is repaired`
        : `ambiguous ${what} in ${file} — ${String(from)} opens ` +
          `${opens.length} blocks`,
    );
  }
  const start = lines.findIndex((line) => from.test(line));
  const end = typeof to === "function" ? to(lines[start]) : to;
  const close = lines.findIndex((line, index) => index > start && end.test(line));
  if (close === -1) {
    throw new Error(
      `unbounded ${what} in ${file} — nothing after ${String(from)} matches ` +
        `${String(end)}, so the capture would run to the end of the file`,
    );
  }
  const block = lines.slice(start + 1, close);
  if (block.length === 0) {
    throw new Error(
      `empty ${what} in ${file} — ${String(from)} and ${String(end)} are ` +
        `adjacent, which would compare equal to any machine list`,
    );
  }
  return block;
}

/**
 * Split a prose inventory into entries. `,`, `/`, ` and ` and ` or ` all
 * separate: the four format sentences write "ODT/ODS/ODP" as one comma-group of
 * three, and treating the conjunction as a separator (rather than stripping it
 * off a comma-split entry) means a comma-less "EPUB and RTF" splits too.
 */
function tokenize(list: string): string[] {
  return list
    .split(/\s*(?:,|\/|\band\b|\bor\b)\s*/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

const repeats = (values: readonly string[]) => [
  ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
];

/**
 * Bidirectional set comparison. Duplicates are rejected first — `includes` sees
 * "PDF, PDF, ZIP" as equal to `["PDF", "ZIP"]`, so a tool listed twice in the
 * `src/mcp.ts` header would otherwise be invisible — and then both directions
 * of a mismatch are asserted together, so one run reports the whole drift.
 */
const expectSameSet = (actual: string[], expected: string[], where: string) => {
  const proseRepeats = repeats(actual);
  const machineRepeats = repeats(expected);
  expect(
    { proseRepeats, machineRepeats },
    `${where} repeats entries — in the prose: ${proseRepeats.join(", ") || "none"}; ` +
      `in the machine list: ${machineRepeats.join(", ") || "none"}`,
  ).toEqual({ proseRepeats: [], machineRepeats: [] });

  const missing = expected.filter((e) => !actual.includes(e));
  const extra = actual.filter((a) => !expected.includes(a));
  const detail = [
    missing.length ? `${where} does not mention: ${missing.join(", ")}` : "",
    extra.length
      ? `${where} mentions entries that do not exist: ${extra.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
  expect({ missing, extra }, detail).toEqual({ missing: [], extra: [] });
};

// ---------------------------------------------------------------------------
// The four document-format sentences
// ---------------------------------------------------------------------------

/**
 * Each anchor captures the list itself, bounded by characters the list cannot
 * contain: `.` ends every one of these sentences, and `<`/`>` keep the JSX
 * site's surrounding `</li> <li>` tags out of the first token.
 */
const FORMAT_SITES: ReadonlyArray<readonly [string, RegExp]> = [
  ["workers/email-ingest/index.ts", /Supported attachments: ([^.]+)\./],
  ["workers/email-ingest/README.md", /([^.<>]+) attachments are forwarded/],
  [
    "src/components/EmailIngestSettings.tsx",
    /([^.<>]+) attachments are included/,
  ],
  [
    "src/app/api/ingest/document/route.ts",
    /Unsupported document type\. Use ([^.]+)\./,
  ],
];

describe("prose inventory parity — document formats", () => {
  it.each(FORMAT_SITES)(
    "%s lists exactly the supported document formats",
    async (file, anchor) => {
      const prose = tokenize(extract(await readProse(file), anchor, file));
      expectSameSet(prose, Object.values(DOCUMENT_FORMAT_LABELS), file);
    },
  );

  it("the labels themselves survive tokenizing", () => {
    const labels = Object.values(DOCUMENT_FORMAT_LABELS);
    const duplicated = repeats(labels);
    expect(
      duplicated,
      `DOCUMENT_FORMAT_LABELS gives two formats the same label: ${duplicated.join(", ")} — ` +
        `a set comparison cannot tell which one a sentence mentions`,
    ).toEqual([]);
    // A label containing a separator (e.g. "OpenDocument Text/ODT") would be
    // split apart by `tokenize` and fail all four sentences with a message
    // about tokens nobody wrote.
    const unsplittable = labels.filter((label) =>
      /[,/]|\band\b|\bor\b/.test(label),
    );
    expect(
      unsplittable,
      `DOCUMENT_FORMAT_LABELS contains a separator the tokenizer splits on: ${unsplittable.join(", ")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The `src/mcp.ts` header `Tools:` block
// ---------------------------------------------------------------------------

describe("prose inventory parity — MCP tool header", () => {
  it("src/mcp.ts's Tools: block lists exactly the registered tools", async () => {
    const file = "src/mcp.ts";
    // Both markers sit unindented at the start of their own (gutter-stripped)
    // line, so a description mentioning "Usage:" cannot close the block early.
    const block = extractBlock(
      await readSourceLines(file),
      /^Tools:\s*$/,
      /^Usage:\s*$/,
      file,
      "Tools: block",
    );
    // One indented ` name — description` entry per line. Matching only at the
    // START of an entry line means an em dash inside a description cannot
    // invent a phantom tool.
    const documented = block
      .map((line) => /^\s+([A-Za-z][A-Za-z0-9_-]*)\s+—/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(
      documented.length,
      `${file}'s Tools: block parsed to no entries — the ' name — description' shape changed`,
    ).toBeGreaterThan(0);

    const server = createMcpServer();
    // `_registeredTools` is private in TypeScript but present at runtime; the
    // same access `mcp-annotations.test.ts` and `mcp.test.ts` use.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = (server as any)._registeredTools;
    expect(
      registry !== null && typeof registry === "object",
      `the MCP SDK no longer exposes the private _registeredTools map, so ` +
        `${file}'s header has no machine side to be compared against`,
    ).toBe(true);
    expectSameSet(documented, Object.keys(registry), file);
  });
});

// ---------------------------------------------------------------------------
// The task-consumer README's `Task` kind list
// ---------------------------------------------------------------------------

describe("prose inventory parity — task kinds", () => {
  it("workers/task-consumer/README.md lists exactly the Task kinds", async () => {
    const file = "workers/task-consumer/README.md";
    const kinds = [...TASK_KINDS];
    const duplicated = repeats(kinds);
    // `satisfies readonly Task["kind"][]` accepts a kind listed twice, and so
    // does a set comparison — so say it here.
    expect(
      duplicated,
      `TASK_KINDS repeats: ${duplicated.join(", ")}`,
    ).toEqual([]);

    const block = extract(
      await readProse(file),
      /`src\/lib\/tasks\.ts`:(.+?)This worker imports/,
      file,
      "task-kind list",
    );
    // Backticked spans in that sentence, kept to the shape a `kind` literal
    // has. The parenthetical `op: "staleness"` / `op: "fix"` are a different
    // axis (a `maintain` field, not a kind) and are excluded by that shape.
    const documented = [...block.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((token) => /^[a-z]+(?:-[a-z]+)*$/.test(token));
    expect(
      documented.length,
      `${file}'s task-kind list parsed to no entries — the backticked shape changed`,
    ).toBeGreaterThan(0);
    expectSameSet(documented, kinds, file);
  });

  /**
   * `TASK_KINDS` is pinned to the `Task` union at compile time, but a kind can
   * still be added to both and never wired into the executor's dispatch. That
   * would only surface as a runtime `null` from `parseTask` (poison → DLQ), so
   * pin the switch here and let `pnpm test` alone catch it.
   */
  it("parseTask dispatches on exactly the Task kinds", async () => {
    const file = "src/lib/tasks.ts";
    const body = extractBlock(
      await readSourceLines(file),
      /^\s*switch \(t\.kind\) \{\s*$/,
      // The switch's own close: a `}` alone on a line at the switch's
      // indentation. Bounding here (rather than at end-of-file) keeps a later
      // string switch — or a `case "…":` inside a comment — from being counted
      // as a dispatched kind, which could mask a case really deleted below.
      (opening) => new RegExp(`^${/^[ \t]*/.exec(opening)?.[0] ?? ""}\\}\\s*$`),
      file,
      "task dispatch switch",
    );
    const dispatched = body
      .map((line) => /^\s*case "([a-z-]+)":/.exec(line)?.[1])
      .filter((kind): kind is string => kind !== undefined);
    expectSameSet(dispatched, [...TASK_KINDS], `${file} (parseTask switch)`);
  });
});

// ---------------------------------------------------------------------------
// The two `MaintainFixType` restatements and the lint-fix route's JSDoc
// ---------------------------------------------------------------------------

/**
 * Backticked spans kept to the shape a check-type literal has. The
 * lowercase-hyphen filter is what keeps `lintType`, `MaintainFixType` and
 * `tasks.ts` — all backticked in the same sentence — from arriving as phantom
 * entries.
 */
const backtickedLiterals = (span: string): string[] =>
  [...span.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((token) => /^[a-z]+(?:-[a-z]+)*$/.test(token));

/** A machine list may not repeat — `satisfies` accepts a member listed twice. */
const expectNoMachineRepeats = (values: readonly string[], name: string) => {
  const duplicated = repeats(values);
  expect(duplicated, `${name} repeats: ${duplicated.join(", ")}`).toEqual([]);
};

describe("prose inventory parity — maintain fix types", () => {
  /**
   * The list is bounded on the right by `: the whole`, NOT by the sentence's
   * period. A `([^.]+)\.` anchor would capture straight through the trailing
   * clause and add `MaintainFixType` and `tasks.ts` as two phantom entries — a
   * failure that reads like drift but is the anchor's fault.
   */
  it("src/lib/maintenance.ts's header lists exactly the MaintainFixType union", async () => {
    const file = "src/lib/maintenance.ts";
    const fixTypes = [...MAINTAIN_FIX_TYPES];
    expectNoMachineRepeats(fixTypes, "MAINTAIN_FIX_TYPES");

    const span = extract(
      await readProse(file),
      /lint fix \(`lintType`\) — ([^:]+): the whole `MaintainFixType` union/,
      file,
      "maintain fix-type list",
    );
    const documented = backtickedLiterals(span);
    expect(
      documented.length,
      `${file}'s maintain fix-type list parsed to no entries — the backticked shape changed`,
    ).toBeGreaterThan(0);
    expectSameSet(documented, fixTypes, file);
  });

  it("workers/task-consumer/README.md lists exactly the MaintainFixType union", async () => {
    const file = "workers/task-consumer/README.md";
    const fixTypes = [...MAINTAIN_FIX_TYPES];
    expectNoMachineRepeats(fixTypes, "MAINTAIN_FIX_TYPES");

    // This README's `fix` bullet ends with a period and `no-LLM lint fix`
    // occurs exactly once, so a period bound is safe here where it is not in
    // `maintenance.ts`. Second inventory in this file — the `Task` kinds above
    // are the first.
    const span = extract(
      await readProse(file),
      /no-LLM lint fix \(`lintType`\): ([^.]+)\./,
      file,
      "maintain fix-type list",
    );
    const documented = backtickedLiterals(span);
    expect(
      documented.length,
      `${file}'s maintain fix-type list parsed to no entries — the backticked shape changed`,
    ).toBeGreaterThan(0);
    expectSameSet(documented, fixTypes, file);
  });
});

// ---------------------------------------------------------------------------
// The lint-fix route's `Supported issue types:` JSDoc block
// ---------------------------------------------------------------------------

describe("prose inventory parity — auto-fixable check types", () => {
  it("src/app/api/lint/fix/route.ts documents exactly the auto-fixable types", async () => {
    const file = "src/app/api/lint/fix/route.ts";
    const types = [...AUTO_FIXABLE_CHECK_TYPES];
    expectNoMachineRepeats(types, "AUTO_FIXABLE_CHECK_TYPES");

    // Bounded at the blank line that ends the bullet list, so the `Request
    // body:` json examples below it are never parsed as inventory entries —
    // they show argument SHAPES, not a second per-type list.
    const block = extractBlock(
      await readSourceLines(file),
      /^Supported issue types:\s*$/,
      /^\s*$/,
      file,
      "Supported issue types: block",
    );
    // Only the leading backticked token of a `- `type`: description.` bullet.
    // Matching at the START of the line means the backticked field names inside
    // a description (`targetSlug`, `message`, `expiry`) cannot invent a type.
    const documented = block
      .map((line) => /^-\s+`([a-z][a-z-]*)`\s*:/.exec(line)?.[1])
      .filter((type): type is string => type !== undefined);
    expect(
      documented.length,
      `${file}'s Supported issue types: block parsed to no entries — the '- \`type\`: description' shape changed`,
    ).toBeGreaterThan(0);
    expectSameSet(documented, types, file);
  });
});

// ---------------------------------------------------------------------------
// The helpers themselves — the ways a "passing" case could assert nothing
// ---------------------------------------------------------------------------

describe("prose inventory parity — extraction guards", () => {
  it("throws naming the file when the anchor no longer matches", () => {
    expect(() =>
      extract(
        "Attachments we happily accept: Markdown, TXT.",
        /Supported attachments: ([^.]+)\./,
        "workers/email-ingest/index.ts",
      ),
    ).toThrow(/no format sentence found in workers\/email-ingest\/index\.ts/);
  });

  it("throws rather than picking one of several matches", () => {
    expect(() =>
      extract(
        "Supported attachments: Markdown. Supported attachments: TXT.",
        /Supported attachments: ([^.]+)\./,
        "fake.ts",
      ),
    ).toThrow(/ambiguous format sentence in fake\.ts .* matches 2 times/);
  });

  it("throws rather than returning an empty inventory", () => {
    expect(() =>
      extract("Supported attachments: .", /Supported attachments: ([^.]*)\./, "fake.ts"),
    ).toThrow(/no format sentence found in fake\.ts/);
  });

  it("bounds a block at its own close, not at the end of the file", () => {
    const lines = [
      "  switch (t.kind) {",
      '    case "wanted":',
      "  }",
      "  switch (other) {",
      '    case "unwanted":',
      "  }",
    ];
    const block = extractBlock(
      lines,
      /^\s*switch \(t\.kind\) \{\s*$/,
      (opening) => new RegExp(`^${/^[ \t]*/.exec(opening)?.[0] ?? ""}\\}\\s*$`),
      "fake.ts",
      "task dispatch switch",
    );
    expect(block).toEqual(['    case "wanted":']);
  });

  it("throws naming the file when a block never closes", () => {
    expect(() =>
      extractBlock(["Tools:", "  a — b"], /^Tools:\s*$/, /^Usage:\s*$/, "fake.ts", "Tools: block"),
    ).toThrow(/unbounded Tools: block in fake\.ts/);
  });

  it("splits slash-joined entries and drops the conjunction, with or without a comma", () => {
    expect(tokenize("ZIP, ODT/ODS/ODP, EPUB, MOBI, Org, and RTF")).toEqual([
      "ZIP",
      "ODT",
      "ODS",
      "ODP",
      "EPUB",
      "MOBI",
      "Org",
      "RTF",
    ]);
    // `or` is the route handler's conjunction; `and` is everyone else's.
    expect(tokenize("Org, or RTF")).toEqual(["Org", "RTF"]);
    // No Oxford comma: the conjunction separates on its own.
    expect(tokenize("ZIP, EPUB and RTF")).toEqual(["ZIP", "EPUB", "RTF"]);
    expect(tokenize("ZIP, EPUB or RTF")).toEqual(["ZIP", "EPUB", "RTF"]);
  });

  it("reports both directions of a mismatch in one run", () => {
    let message = "";
    try {
      expectSameSet(["A", "B"], ["A", "C"], "somewhere");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/somewhere does not mention: C/);
    expect(message).toMatch(/somewhere mentions entries that do not exist: B/);
    expect(() => expectSameSet(["A"], ["A"], "somewhere")).not.toThrow();
  });

  it("keeps only backticked spans shaped like a check-type literal", () => {
    // The filter is what decides which backticked span counts as an entry, and
    // both `MaintainFixType` sentences put non-entries in backticks right
    // beside the list. `lintType` is camelCase, `MaintainFixType` is
    // PascalCase, and `tasks.ts` carries a dot — none of the three may survive.
    expect(
      backtickedLiterals(
        "a lint fix (`lintType`) — `orphan-page`, `stale-page`: the whole `MaintainFixType` union (`tasks.ts`)",
      ),
    ).toEqual(["orphan-page", "stale-page"]);
  });

  it("rejects a duplicated entry that a set comparison would hide", () => {
    expect(() =>
      expectSameSet(["PDF", "PDF", "ZIP"], ["PDF", "ZIP"], "somewhere"),
    ).toThrow(/somewhere repeats entries/);
  });
});
