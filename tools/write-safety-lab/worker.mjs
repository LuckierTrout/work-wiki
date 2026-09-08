// LOCAL SYNTHETIC PROOF ONLY. No deploy config, production auth or app imports.
// Fault/barrier routes deliberately belong only to the isolated test runtime.
import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const PATH = /^[a-zA-Z0-9_-]+(?:[./][a-zA-Z0-9_-]+)*$/;
// Unicode mode treats valid surrogate pairs as a single non-surrogate code point.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
function fail(code, status = 409) {
  throw Object.assign(new Error(code), { status });
}
async function hash(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function validate(input) {
  if (!input || typeof input.operation !== "string" || !ID.test(input.operation) ||
      !Number.isSafeInteger(input.generation) || input.generation < 1 ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      !Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 32 ||
      ![undefined, "before-publish", "in-transaction", "after-commit"].includes(input.fault) ||
      (input.pause !== undefined && (typeof input.pause !== "string" || !ID.test(input.pause)))) fail("invalid-request", 400);
  const paths = new Set();
  const changes = input.changes.map((change) => {
    if (!change || typeof change.path !== "string" || change.path.length > 200 ||
        !PATH.test(change.path) || paths.has(change.path) ||
        !(change.content === null || typeof change.content === "string") ||
        (typeof change.content === "string" &&
          (LONE_SURROGATE.test(change.content) || encoder.encode(change.content).length > 8192))) {
      fail("invalid-change", 400);
    }
    paths.add(change.path);
    return { path: change.path, content: change.content };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { operation: input.operation, generation: input.generation, revision: input.revision, changes };
}

export class CommitAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER, revision INTEGER);
      INSERT OR IGNORE INTO state VALUES (1,1,0);
      CREATE TABLE IF NOT EXISTS refs (path TEXT PRIMARY KEY, blob TEXT, size INTEGER);
      CREATE TABLE IF NOT EXISTS receipts (operation TEXT PRIMARY KEY, digest TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, generation INTEGER, revision INTEGER, snapshot TEXT, status TEXT);
      CREATE TABLE IF NOT EXISTS projection (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER, revision INTEGER, snapshot TEXT);
    `);
  }
  state() { return this.sql.exec("SELECT generation, revision FROM state").one(); }
  refs() { return this.sql.exec("SELECT path, blob, size FROM refs ORDER BY path").toArray(); }
  receipt(operation, digest) {
    const row = this.sql.exec("SELECT * FROM receipts WHERE operation=?", operation).toArray()[0];
    if (!row) return null;
    if (row.digest !== digest) fail("operation-conflict");
    return JSON.parse(row.result);
  }
  eligible(input) {
    const state = this.state();
    if (input.generation !== state.generation) fail("stale-generation");
    if (input.revision !== state.revision) fail("revision-conflict");
  }
  enqueue() {
    const { generation, revision } = this.state();
    this.sql.exec("INSERT INTO outbox VALUES (?,?,?,?,?)", `${generation}:${revision}`,
      generation, revision, JSON.stringify(this.refs()), "pending");
  }
  async commit(raw) {
    const input = validate(raw);
    const digest = await hash(JSON.stringify(input));
    const previous = this.receipt(input.operation, digest);
    if (previous) return previous;
    this.eligible(input);
    const prepared = [];
    for (const change of input.changes) {
      if (change.content === null) { prepared.push({ path: change.path, blob: null, size: 0 }); continue; }
      const bytes = encoder.encode(change.content);
      const blob = await hash(bytes);
      await this.env.CONTENT.put(blob, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
      // Verify both new uploads and reused create-only objects before publishing.
      const stored = await this.env.CONTENT.get(blob);
      if (!stored || await hash(await stored.arrayBuffer()) !== blob) fail("blob-integrity", 500);
      prepared.push({ path: change.path, blob, size: bytes.length });
    }
    if (raw.pause) await this.env.BARRIER.fetch(`https://barrier.invalid/${raw.pause}`);
    if (raw.fault === "before-publish") fail("injected-before-publish", 503);
    const result = this.ctx.storage.transactionSync(() => {
      const racedReceipt = this.receipt(input.operation, digest);
      if (racedReceipt) return racedReceipt;
      this.eligible(input); // No await from here through receipt + outbox publication.
      for (const item of prepared) this.sql.exec("INSERT OR REPLACE INTO refs VALUES (?,?,?)", item.path, item.blob, item.size);
      if (raw.fault === "in-transaction") fail("injected-transaction", 503);
      this.sql.exec("UPDATE state SET revision=revision+1 WHERE id=1");
      const receipt = { operation: input.operation, digest, ...this.state() };
      this.sql.exec("INSERT INTO receipts VALUES (?,?,?)", input.operation, digest, JSON.stringify(receipt));
      this.enqueue();
      return receipt;
    });
    if (raw.fault === "after-commit") fail("injected-after-commit", 503);
    return result;
  }
  advance(input) {
    if (!input || !Number.isSafeInteger(input.generation) || !Number.isSafeInteger(input.revision)) fail("invalid-request", 400);
    return this.ctx.storage.transactionSync(() => {
      this.eligible(input);
      this.sql.exec("UPDATE state SET generation=generation+1 WHERE id=1");
      this.enqueue();
      return this.state();
    });
  }
  project(input) {
    if (!input || typeof input.id !== "string" || input.id.length > 80) fail("invalid-request", 400);
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec("SELECT * FROM outbox WHERE id=?", input.id).toArray()[0];
      if (!row) fail("not-found", 404);
      const state = this.state();
      if (row.generation !== state.generation || row.revision !== state.revision) {
        this.sql.exec("UPDATE outbox SET status='superseded' WHERE id=?", input.id);
        return { status: "superseded" };
      }
      this.sql.exec("INSERT OR REPLACE INTO projection VALUES (1,?,?,?)", row.generation, row.revision, row.snapshot);
      this.sql.exec("UPDATE outbox SET status='applied' WHERE id=?", input.id);
      return { status: "applied" };
    });
  }
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/state") return Response.json({
        ...this.state(), refs: this.refs(),
        receipts: this.sql.exec("SELECT * FROM receipts ORDER BY operation").toArray(),
        outbox: this.sql.exec("SELECT * FROM outbox ORDER BY generation, revision").toArray(),
        projection: this.sql.exec("SELECT * FROM projection").toArray(),
      });
      if (request.method === "GET" && ["/read", "/stat", "/list"].includes(url.pathname)) {
        const state = this.state();
        const refs = this.refs().filter((row) => row.blob !== null);
        if (url.pathname === "/list") return Response.json({ ...state, paths: refs.map((row) => row.path) });
        const ref = refs.find((row) => row.path === url.searchParams.get("path"));
        if (!ref) fail("not-found", 404);
        if (url.pathname === "/stat") return Response.json({ ...state, size: ref.size });
        const object = await this.env.CONTENT.get(ref.blob);
        if (!object) fail("blob-missing", 500);
        const bytes = await object.arrayBuffer();
        if (await hash(bytes) !== ref.blob) fail("blob-integrity", 500);
        // Decode only verified bytes, preserving a caller's leading BOM as content.
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        return Response.json({ ...state, content });
      }
      if (request.method !== "POST") fail("not-found", 404);
      // Bound the stream, not just a caller-controlled Content-Length header.
      const reader = request.body?.getReader();
      if (!reader) fail("invalid-request", 400);
      let text = "", count = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        count += value.byteLength;
        if (count > 300_000) { await reader.cancel(); fail("request-too-large", 413); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      let input;
      try { input = JSON.parse(text); } catch { fail("invalid-json", 400); }
      if (url.pathname === "/commit") return Response.json(await this.commit(input));
      if (url.pathname === "/advance") return Response.json(this.advance(input));
      if (url.pathname === "/project") return Response.json(this.project(input));
      fail("not-found", 404);
    } catch (error) {
      return Response.json({ error: error.status ? error.message : "runtime-error" }, { status: error.status ?? 500 });
    }
  }
}

const worker = {
  fetch(request, env) {
    return env.AUTHORITY.get(env.AUTHORITY.idFromName("synthetic-workspace")).fetch(request);
  },
};
export default worker;
