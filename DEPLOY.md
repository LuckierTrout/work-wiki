# Self-Hosting Guide

Run the LLM Wiki as a Docker container with a single command.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (v20+)
- [Docker Compose](https://docs.docker.com/compose/install/) (v2+)
- An API key for at least one LLM provider

## Quick Start

1. **Clone the repository**

   ```sh
   git clone https://github.com/yologdev/yopedia.git
   cd work-wiki
   ```

2. **Create a `.env` file** with your API key

   ```sh
   echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
   ```

3. **Start the app**

   ```sh
   docker compose up -d
   ```

4. **Open** [http://localhost:3000](http://localhost:3000)

That's it. Your wiki data persists in Docker volumes across restarts.

## Environment Variables

Configure your LLM provider by setting the relevant API key in `.env`:

| Variable | Provider | Example |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude | `sk-ant-api03-...` |
| `OPENAI_API_KEY` | OpenAI | `sk-proj-...` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini | `AIza...` |
| `OLLAMA_BASE_URL` | Ollama (local) | `http://host.docker.internal:11434` |

You only need **one** provider. The app auto-detects which key is set.

### Additional Settings

| Variable | Description | Default |
|---|---|---|
| `LLM_WIKI_PROVIDER` | Force a specific provider (`anthropic`, `openai`, `google`, `ollama`) | Auto-detected |
| `LLM_WIKI_MODEL` | Override the default model name | Provider default |
| `EMBEDDING_PROVIDER` | Force the embedding provider (`openai`, `google`, `ollama`; `workers-ai` **only on Cloudflare Workers** — see below) | Settings selection, then auto-detected |
| `EMBEDDING_MODEL` | Override the embedding model name — must be one of the supported `@cf/` embedding ids when the embedding provider is `workers-ai`, and must sit outside `@cf/` when it is not (see below) | Provider default |
| `LOG_LEVEL` | Minimum log level (`debug`, `info`, `warn`, `error`, `silent`) | `warn` |
| `PORT` | Server port inside the container | `3000` |

**`EMBEDDING_PROVIDER=workers-ai` requires the Cloudflare Workers runtime.** The
provider reaches Cloudflare through the `AI` binding declared in
`wrangler.jsonc`, which does not exist in the Docker/compose deployment this
document describes. Off Workers the binding resolves to nothing and the override
is dropped by the **embedding path** silently — embeddings are then disabled
entirely, with no error in the logs. On Docker, set this to `openai`, `google`,
or `ollama`, or leave it unset and let the app auto-detect.

**The Workbench Settings surface no longer stays quiet about it.** Selecting
Cloudflare Workers AI as the embedding provider on a deployment with no `AI`
binding now refuses the vector-search switch by name — *"Vector search needs the
Cloudflare AI binding before it can be turned on"* — and a save that tries is
rejected with the same sentence plus the two ways out (bind `ai` in
`wrangler.jsonc`, or choose another embedding provider). This is the one place
the missing binding is reported before content is ingested; the log stays silent
because `getWorkersAiBinding()` only warns when it is ON the Workers runtime with
`AI` unbound, which is a misconfiguration rather than "not Cloudflare".

The refusal is also announced on the **Embedding provider select itself**, not
only on the switch, because that select is the one control on the surface that
can move this leg — nothing there binds `ai` in `wrangler.jsonc`, but choosing a
different provider drops the requirement entirely. The select is marked invalid
on the same rule the Embedding model box follows: only when the **stored**
selection is the wrong one, because that is the only case editing it can fix.

**When `EMBEDDING_PROVIDER` is what forces the selection, the second way out
changes.** The variable wins over the stored selection in every code path, so
"choose another embedding provider" would be advice the select cannot follow —
a different provider picked in Settings changes nothing and the switch stays
refused. The refusal names the variable instead, so the way out becomes an
ordered pair of steps rather than a dead end. In full:

> Vector search needs the Cloudflare AI binding before it can be turned on.
> Workers AI embeds through the Cloudflare AI binding, which exists only on the
> Workers runtime — bind ai in wrangler.jsonc, or unset EMBEDDING_PROVIDER to
> choose another embedding provider.

The select is **described but not marked invalid** here, for the same reason the
model box is not marked for an `EMBEDDING_MODEL`-owned mismatch: marking a
control the owner cannot fix from there is a dead end. It also goes on showing
the **stored** selection rather than the forced one, because the box edits the
store and the store is what applies once the variable is unset — so on a
deployment with `EMBEDDING_PROVIDER=workers-ai` and `openai` in Settings, the
select reads OpenAI while the sentence beside it is about Workers AI.

The same limit applies here as to the model rule below: the older `/settings`
page saves the embedding provider through a flat request that never enters this
gate, so `workers-ai` selected there is still stored silently on a deployment
with no binding. The refusal guards the Workbench switch, not the config file.

Those are not safe answers by themselves, though: `openai` and `google` are
dropped just as silently when the matching key is missing (`OPENAI_API_KEY` /
`GOOGLE_GENERATIVE_AI_API_KEY`, or the key stored in Settings → Embeddings).
Forcing a provider also switches OFF the auto-detection fallback, so an override
that cannot resolve leaves embeddings disabled rather than picking a provider
that would have worked. Set the variable only alongside the credential it needs.

**`EMBEDDING_MODEL` must name a model the selected provider can actually serve.**
Under `workers-ai` it must be one of the supported Cloudflare embedding ids:

| Model id | Dimensions |
|---|---|
| `@cf/baai/bge-small-en-v1.5` | 384 |
| `@cf/baai/bge-base-en-v1.5` | 768 |
| `@cf/baai/bge-large-en-v1.5` | 1024 |
| `@cf/baai/bge-m3` | 1024 (default; multilingual) |

Being inside the `@cf/` namespace is **not** enough. A bare `@cf/`, or a real
Cloudflare model that is not an embedding model (`@cf/llava-hf/llava-1.5-7b-hf`,
`@cf/meta/llama-3.1-8b-instruct`), is rejected here rather than failing later at
the Workers AI binding. Under every other embedding provider the id must simply
sit **outside** the `@cf/` namespace — this check does not validate one
non-Workers-AI provider's model catalog against another's.

Model ids are **case-sensitive**: `@CF/baai/bge-m3` is not `@cf/baai/bge-m3`,
and a capitalisation typo is rejected under every provider — under `workers-ai`
because it is not in the table above, and elsewhere because it is not recognised
as a Workers AI id at all. Copy the ids exactly as written.

The value is trimmed before it is used, and a blank or whitespace-only
`EMBEDDING_MODEL` counts as **unset** (the provider default applies) rather than
as a model named `" "`.

Two separate things happen to an id the resolved provider cannot serve:

- **The Workbench Settings surface refuses it.** The vector-search switch in the
  Workbench's Embeddings settings cannot be turned on while the model id and the
  **explicitly selected** embedding provider disagree, and a save that tries is
  rejected with a message naming the supported ids (under `workers-ai`) or the
  namespace boundary (under the other providers). Two limits are worth knowing
  before you rely on it. The older `/settings` page saves the embedding model
  through a flat request that never runs this check, so a mismatch entered there
  is accepted silently — it is trimmed on the way in, but not validated. And the
  refusal only names a model rule once an embedding provider has actually been
  chosen — with the provider left to auto-detection the switch refuses for the
  missing provider instead.

  When the mismatched id came from **this variable** rather than from the
  Settings store, the refusal says so: it appends *"That value comes from
  `EMBEDDING_MODEL`, so a model typed here cannot lift this until that variable
  is unset."* Without that sentence the message named only the id rule, and
  typing a supported id into the Embedding model box changed nothing — the
  override wins at runtime and the switch stayed off. The control that holds the
  wrong value — the Embedding model box, or the Embedding provider select for a
  missing `AI` binding — is marked invalid only when the **stored** value is the
  wrong one, because that is the only case editing it can fix. A read-only
  deployment (`YOPEDIA_READONLY`) is the same case whole: every field is
  described and none is marked. On such a deployment the two provider pickers,
  the vector switch and all seven **text** rows — Chat model, Ingest model,
  Custom base URL, Embedding model, Embedding endpoint, Firecrawl base URL and
  the LLM timeout — now also announce that settings are read-only here, rather
  than leaving that sentence unassociated beside the Save button. The three
  **API-key** rows (Custom, Embedding, Firecrawl) are the exception: they still
  announce only whether a key is stored.

  **A switch that is already ON is acknowledged as on, not described as
  un-turn-on-able.** The settings surface serves the stored flag rather than the
  effective one, so a configuration whose legs went missing renders the box
  *checked*. Beside it the sentence names the same unmet legs, but addressed to
  a switch that is already on — *"Vector search is switched on, but it needs an
  endpoint before it can run. Turn it off, or supply what is missing."* —
  because "before it can be turned on" beside a ticked box describes some other
  deployment. The sentence is about the settings as they currently stand,
  including unsaved edits, and not a claim about what the deployment is doing;
  the save bar's standing sentence is what qualifies unsaved edits, and on a
  read-only deployment the read-only sentence rides here too. The box stays
  operable in that state: turning vector search **off** is always allowed, so an
  owner is never stranded with a switch whose legs have since gone missing.

  An unrelated Workbench save — a chat model, an LLM timeout — is **not** refused
  by a mismatch it did not create, even on a deployment whose stored vector
  switch is on. The gate re-runs when the save turns the switch on or moves one
  of the values it reads (the embedding provider, model, endpoint or key). A
  stored **model** mismatch still reads as vector search **off** to the rest of
  the app until it is fixed or the switch is turned off.

  A missing **`AI` binding** is the exception to that last sentence: the
  server-side accessor that reports the effective switch cannot ask whether the
  binding exists, so it keeps reporting a stored `workers-ai` switch as on. That
  costs nothing — the embedding path resolves no provider without the binding and
  so embeds nothing either way — but it means the Settings refusal, not the
  effective switch, is where a missing binding shows up.
- **The embedding path substitutes the provider default, and says so.** The
  mismatched id is ignored and embedding continues with the default for the
  resolved provider (`@cf/baai/bge-m3` for Workers AI,
  `text-embedding-3-small` for OpenAI, `gemini-embedding-001` for Google,
  `nomic-embed-text` for Ollama), so content is still embedded — just not with
  the model named here. The substitution emits one warning on the `embeddings`
  tag naming the dropped id, the provider, and the model used instead, so a
  mismatch that arrived through the flat `/settings` route or through this
  variable is visible in the container logs:

  ```
  [embeddings] Embedding model "text-embedding-3-small" cannot be served by the
  "workers-ai" embedding provider; embedding with "@cf/baai/bge-m3" instead. ...
  ```

  This is a `warn`-level line, so `LOG_LEVEL` must be `warn` or below for it to
  appear at all — `LOG_LEVEL=error` or `silent` restores exactly the silence
  this warning exists to end.

  **It is said once, not once per embed.** The line is emitted once per distinct
  `(provider, model)` misconfiguration per process — every embed door re-enters
  the same resolver, so an unthrottled warning repeated itself roughly twice per
  page of a rebuild. On Cloudflare the scope is the *isolate*, so while the
  misconfiguration stands the line lands in only some isolates' logs rather than
  in every request. A changed id is a new misconfiguration and speaks again; the
  identical one fixed and then re-introduced within the same process stays
  silent until a restart.

That substitution is the expensive half. Different embedding models generally
produce vectors of different widths, and every stored vector is tagged with the
model that produced it. Once a store holds vectors from two models, queries
either fail outright on a dimension mismatch or have every hit discarded by the
model filter — either way vector search returns nothing until the whole corpus
is re-embedded. So a mismatch does not stop embeddings; it changes which model
does them, and can cost you the index you already built. If the model you set
here does not appear to be in use, grep the logs for the `embeddings` warning
above — it names the id that was dropped and the one embedding actually ran
with. Grep the whole retained window rather than the last few minutes, and read
a *single* occurrence as the full report: because the line is said once per
process (per isolate on Cloudflare), the absence of a repeated line says
nothing about whether the mismatch is still standing. Confirm the current state
from Settings or from the model tag on freshly written vectors, not from the
log's silence.

## Volume Mounts

The compose file defines two named volumes:

| Volume | Container Path | Purpose |
|---|---|---|
| `wiki-data` | `/app/wiki` | Generated wiki markdown pages |
| `raw-data` | `/app/raw` | Ingested source documents |

Your wiki data lives in these volumes and persists even if you remove the container.

### Using a local directory instead

To map wiki data to a directory on your host machine:

```yaml
# docker-compose.yml override
services:
  wiki:
    volumes:
      - ./my-wiki:/app/wiki
      - ./my-sources:/app/raw
```

## Using Ollama (Local LLMs)

If you run [Ollama](https://ollama.com) on your host machine, the container needs to reach it:

```sh
# .env
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

On Linux, you may need to add `--add-host=host.docker.internal:host-gateway` or use the host network:

```yaml
services:
  wiki:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## Updating

Pull the latest code and rebuild:

```sh
git pull
docker compose up -d --build
```

Your wiki data in the volumes is preserved.

## Building from Source (without Docker)

If you prefer running directly on your machine:

1. **Install Node.js 22+** and **pnpm**

   ```sh
   corepack enable
   ```

2. **Install dependencies**

   ```sh
   pnpm install
   ```

3. **Create `.env.local`** with your API key

   ```sh
   echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
   ```

4. **Run in development mode**

   ```sh
   pnpm dev
   ```

   Or build and run in production mode:

   ```sh
   pnpm build
   pnpm start
   ```

## Troubleshooting

### Container exits immediately

Check the logs:

```sh
docker compose logs wiki
```

Most common cause: missing API key in `.env`.

### Port already in use

Change the host port mapping:

```yaml
ports:
  - "8080:3000"
```

### Permission errors on mounted directories

Ensure the host directories are writable, or use named volumes (the default).
