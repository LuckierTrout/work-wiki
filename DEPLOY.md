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
| `YOPEDIA_READONLY` | Set to `1` to refuse most content writes — see [Read-only deployments](#read-only-deployments) | Unset (writable) |

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
> Cloudflare Workers AI embeds through the Cloudflare AI binding, which exists
> only on the Workers runtime — bind ai in wrangler.jsonc, or unset
> EMBEDDING_PROVIDER to choose another embedding provider.

Both quotes above are the **turning-on** frame — what a save that asks to switch
vector search on is answered with. A save against a switch the store already held
on is answered over the same legs and the same notes, in the switched-on frame
instead: *"Vector search is switched on, but it needs the Cloudflare AI binding
before it can run. Turn it off, or supply what is missing."* See *A switch that
is already ON* below for the rule that picks between them.

The select is **described but not marked invalid** here, for the same reason the
model box is not marked for an `EMBEDDING_MODEL`-owned mismatch: marking a
control the owner cannot fix from there is a dead end. It also goes on showing
the **stored** selection rather than the forced one, because the box edits the
store and the store is what applies once the variable is unset — so on a
deployment with `EMBEDDING_PROVIDER=workers-ai` and `openai` in Settings, the
select reads OpenAI while the sentence beside it is about Cloudflare Workers AI.

The same limit applies here as to the model rule below: the older `/settings`
page now runs this same gate on its flat request. It fires only when the
request moves a vector input the rule reads and vector search is **already
stored on** — that request cannot move `vectorSearchEnabled` itself, so it
never refuses in the turning-on frame. A refusal is then normally narrowed to
the legs that flat body could have moved: the embedding model, the only vector
control that page renders, plus the provider and binding legs when a direct API
caller sends `embeddingProvider`. The exception is a save that **breaks a
configuration that previously worked** — that one refuses over any unmet leg,
actionable from that page or not. With vector search off none of it applies: a
flat save is not gated at all, so a provider sent to the flat `/api/settings`
route on a deployment with no binding is stored without the *vector rule*
having anything to say about it.

One thing does stop it, though, and it is a separate rule from the gate above.
While `EMBEDDING_PROVIDER` names a **supported** provider, the route refuses to
**move** the stored embedding provider at all — through the flat field and
through `workbench` alike — because moving it deletes the stored embedding key
and endpoint belonging to the very vendor the variable forces, and no save can
change which vendor embeds while the variable is set. The Settings select is
already disabled for that reason; the route closes the same door against a
direct `PUT`, a tab left open from before the variable was set, and a CLI:

> The environment sets EMBEDDING_PROVIDER=workers-ai, and that wins at runtime.
> The embedding provider cannot be changed until that variable is unset.

It fires on a **move**, never on presence — every Settings save re-sends the
provider it is already storing, so an unrelated edit (a timeout, the API door)
still lands untouched on a pinned deployment — and a refused request writes
nothing at all, so the key and the endpoint survive it. A **junk**
`EMBEDDING_PROVIDER` does not pin anything: it names no vendor, so there is no
credential a move could sabotage, and the store is exactly what applies once the
variable is corrected. The config file itself is still ungoverned either way —
every rule here only ever runs on an API save.

Those are not safe answers by themselves, though: `openai` and `google` are
dropped just as silently when the matching key is missing (`OPENAI_API_KEY` /
`GOOGLE_GENERATIVE_AI_API_KEY`, or the key stored in Settings → Embeddings).
Forcing a provider also switches OFF the auto-detection fallback, so an override
that cannot resolve leaves embeddings disabled rather than picking a provider
that would have worked. Set the variable only alongside the credential it needs.

**A provider that cannot embed at all is refused out loud, and the warning now
names where the value came from.** `EMBEDDING_PROVIDER=deepseek` — or any value
outside `openai`, `google`, `ollama`, `workers-ai` — disables embeddings rather
than falling through to auto-detection, and says so once on the `embeddings` tag:

```
[embeddings] EMBEDDING_PROVIDER="deepseek" is not embedding-capable
(valid: openai, google, ollama, workers-ai); embeddings are disabled.
Fix the override or unset it to auto-detect.
```

That log line is no longer the only place it shows. The Workbench embeddings row
says the same thing where the owner is actually looking — beside the provider
select, in place of the sentence that would otherwise describe the box:

> EMBEDDING_PROVIDER is set to unsupported value “deepseek”. Nothing will embed
> until the environment is corrected.

The select stays **editable** under it, unlike the pinned case above: an
unsupported value names no vendor to protect, and the stored selection is what
applies the moment the variable is fixed. The vector switch agrees rather than
reporting itself satisfied — with a junk variable set, nothing embeds and the
runtime reads the switch as off, so a chat that would have used vector search
falls back to keyword retrieval and says so. Beside the switch it names the
variable, because on a deployment whose stored embedding config is complete
there is nothing else on the page left to fix:

> Vector search needs an embedding provider before it can be turned on. The
> provider comes from EMBEDDING_PROVIDER, so a provider chosen in the Embedding
> provider select cannot lift this until that variable is unset or corrected.

`PUT /api/settings` refuses a turn-on with that same sentence as its `400` body,
so a CLI or a stale tab is told which variable to fix too.

The same unservable value can also arrive from the **store**, because Settings
saves an embedding provider of its own and the variable is only the first of the
two feeders. That case gets its own sentence — it names the *stored* provider and
points at Settings, with no `EMBEDDING_PROVIDER=` and no instruction to unset a
variable nobody set:

```
[embeddings] The embedding provider saved in Settings, "deepseek", is not
embedding-capable (valid: openai, google, ollama, workers-ai); embeddings are
disabled. Choose a supported embedding provider in Settings.
```

Which value *wins* is unchanged — the variable still beats the store. Only the
sentence learned where the value it is refusing came from.

One deployment does not hear both at once: a set `EMBEDDING_PROVIDER` shadows the
stored selection entirely, so the Settings sentence is only reachable once the
variable is unset. What the throttle guarantees is that unsetting it does not
cost you the second line — the source is part of the misconfiguration's identity,
so a stored `deepseek` uncovered by removing an env `deepseek` is a *new* fact
and is said once on its own terms, rather than being silenced as a repeat of the
sentence you already fixed.

**The Ollama chat endpoint and the Ollama embedding endpoint are two different
settings.** `OLLAMA_BASE_URL` (and the Ollama endpoint saved in Settings) is the
**chat / generation** endpoint: it is what text generation dials. Embeddings dial
the **Embedding endpoint** in Settings → Embeddings — the same one field `openai`
and `google` have always read. Ollama used to be the exception, reaching its
server through the chat endpoint while the Embedding endpoint box accepted a
value nothing read; the two no longer overlap.

`OLLAMA_BASE_URL` still *detects* Ollama as a provider — setting it can still be
what causes `ollama` to be selected for embeddings — it just no longer decides
where that embedding request is sent.

> **Migration.** If you embed with Ollama and have only ever set
> `OLLAMA_BASE_URL` (or only the Ollama endpoint in Settings), **save an
> Embedding endpoint** — usually the same URL. Until you do, embeddings go to the
> Ollama SDK's own default, `http://127.0.0.1:11434/api`, which is correct for a
> local install on the same host and wrong for everyone else. The app says so
> once, on the `embeddings` tag:
>
> ```
> [embeddings] Ollama is the selected embedding provider, but no embedding
> endpoint is saved (Settings → Embeddings → "Embedding endpoint" is empty), so
> embeddings are going to the SDK's own default, http://127.0.0.1:11434/api.
> OLLAMA_BASE_URL is the chat endpoint and is not read here — save an Embedding
> endpoint if that default is not where Ollama is listening.
> ```
>
> The endpoint stays **optional**: turning vector search on does not demand one
> from Ollama, because the SDK default is a working configuration for a local
> install. There is no `EMBEDDING_BASE_URL` environment variable — the Embedding
> endpoint is stored through Settings only.

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
  before you rely on it. The older `/settings` page now runs this same check on
  its flat request, but only against a store where vector search is **already
  on** — and there, a save that breaks a configuration that previously worked
  is refused over any unmet leg, not just the model box (see the provider rule
  above). With the switch off that flat save is not gated at all, so a mismatch
  entered there is still accepted silently — it is trimmed on the way in, but
  not validated. And the refusal only names a model rule once an embedding
  provider has actually been chosen — with the provider left to auto-detection
  the switch refuses for the missing provider instead.

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
  **API-key** rows (Custom, Embedding, Firecrawl) announce it too, appended to
  whether a key is stored: a password box that shows nothing has that hint as its
  only state, and on a read-only deployment its Remove button is not merely
  refused but gone, so the sentence is the only thing standing in for the missing
  affordance.

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

  A **refused save** now carries the same frame. The route picks it from the flag
  the store held *before* the request — its analogue of the ticked box the
  browser reads: a save that asks to turn the switch **on** is still told *"…
  before it can be turned on"*, while a save against a switch that was already on
  is answered with the switched-on sentence, since that is what lands in the save
  bar beside the still-checked box. Same unmet legs, same notes, same order in
  either frame; which situations are refused at all is unchanged.

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
here does not appear to be in use, **the flat `/settings` page answers
directly**: the embedding model field shows what is *set* (and where it came
from — on that page the box is locked to the variable's value when
`EMBEDDING_MODEL` owns it, which is what makes the source unambiguous), and when
the model actually embedding is a different one, a note beneath the field names
it — "Not in effect. This deployment embeds with `…`".

Read the absence of that note carefully, because it means "no substitution" only
alongside the rest of the page. It is absent in three different states: the id
in the box is the id embedding (the case you want); **nothing is set** at all,
so the box is empty and the provider's own default is running, unnamed here;
and **nothing is embedding** at all — no resolvable embedding provider — in
which case the id in the box is running nowhere and the substitution note would
be a lie, so it is withheld; what tells you *that* is the connection line at the
top of the page, which drops its `• embeddings ✓` marker. So the note answers
one question only — "is the id I set being substituted" — and the box and the
connection line answer the other two.

**Both Settings surfaces answer this question.** The **Workbench** Settings canvas
says the same thing on its Embedding model row, as part of the row's own
description rather than as a note beneath the box:

> Not in effect. This deployment embeds with `…` — the embedding provider cannot
> serve the model that is set, so it uses its own default instead. Vectors are
> tagged with the model that produced them, so an index built with a different
> model needs rebuilding.

The wording is shaped for the row it rides on rather than copied from the flat
page: the canvas box shows the **stored** model, which is empty whenever
`EMBEDDING_MODEL` owns the value, so the sentence names "the model that is set"
instead of pointing at a control. Both surfaces withhold it when there is nothing
actually in effect to name, and both apply it regardless of which embedding
provider is selected, or whether one is selected at all. The canvas re-reads it
on save, since a landed `PUT` serves the payload back from a cache the write has
just re-primed.

**The canvas withholds it on one further rule, and the flat page does not.** The
note states a fact only the **server** can resolve, and on the canvas it sits in
the Embedding model row's own description beside two sentences read off the
**unsaved draft** — the `EMBEDDING_MODEL` override note and the vector gate's
complaint. So the moment an owner edits the model box or moves the provider
select, the canvas's note goes quiet: it would otherwise go on saying "this
deployment embeds with …" in the present tense about a value the owner has just
replaced, beside a complaint that has already moved with the edit. Putting both
fields back to their stored values brings it straight back, and so does a save,
which re-seeds it from what the server resolved. The rule does **not** apply
while `EMBEDDING_MODEL` is set: the variable wins over the box, so the reported
substitution stays true whatever is typed there, and only a provider move
withholds the note. The flat page has no equivalent rule — its note rides in
that page's model-input description too, and it goes on being shown while the box
is edited, until a save lands.

What changed on the canvas is the state its model row was previously **silent**
in: with **no embedding provider chosen**, `vectorSearchFieldIssue` returns the
provider leg early and never produces a model complaint, so that row had nothing
to say at all — while the deployment was quietly embedding with something other
than the id in the box. (The flat page was never silent there; its note has no
provider term.)

The **locked box** is a `/settings` behaviour and not a general one. The Workbench
canvas deliberately does the opposite with a forced value: it keeps the *stored*
selection in the control and says the environment's value beside it, for the
reason given above about the provider select — so do not go hunting on that
surface for a locked box that only exists on the flat page.

On either surface the mismatch is described, not marked: the field is not
flagged invalid and the save is not blocked, because an `EMBEDDING_MODEL`-owned
mismatch cannot be fixed from that box at all — unset the variable, or set it to
an id the embedding provider serves.

**The other half of that cost has its own line, throttled the same way.** Once a
store holds only vectors from a model the deployment no longer uses, every
search still runs — it just discards every hit — and `searchByVector` leaves a
breadcrumb so that is diagnosable rather than looking like "no matches":

```
[embeddings] searchByVector: the model filter dropped every match
(active="@cf/baai/bge-m3") — likely embedding-model drift; rebuild embeddings.
```

Like the substitution warning it is said **once per process** (per isolate on
Cloudflare), keyed on the *active model name*: drift is standing state that holds
until the corpus is rebuilt, and the door it is logged from runs once per search,
so an unthrottled line repeated itself for every query anyone ran. A change to
the active model that still drifts is a new identity and speaks again. The line
deliberately names **no match count** — the count belongs to the query, not to the
misconfiguration, and putting it in the sentence is what would make each query's
line look different enough to be worth repeating.

It carries the same two operational caveats as the substitution warning, for the
same two reasons. It is a `warn`-level line, so `LOG_LEVEL` must be `warn` or
below for it to appear at all — `LOG_LEVEL=error` or `silent` restores exactly
the silence it exists to end. And because it is said once per process, a **single
occurrence is the full report**: its absence from the last few minutes of log
says nothing about whether the drift is still standing, and the fix is confirmed
by a search returning results again, not by the log going quiet.

The logs say the same thing from the other side: grep for the
`cannot be served by` **substitution** warning quoted earlier in this section —
it names the id that was dropped and the one embedding actually ran with. (Not
the drift line above, which names neither: it reports the corpus that is now
unreachable, not the id that was substituted.) Grep the whole retained window
rather than the last few minutes, and read a *single* occurrence as the full
report: because the line is said once per process (per isolate on Cloudflare),
the absence of a repeated line says nothing about whether the mismatch is still
standing. So confirm the current state from
Settings or from the model tag on freshly written vectors, not from the log's
silence.

### Read-only deployments

**`YOPEDIA_READONLY` is on at the literal `1` and at nothing else.** The check is
a plain `process.env.YOPEDIA_READONLY === "1"` in `src/lib/config.ts` — exact
and untrimmed — so `true`, `yes`, `on`, a value with a stray trailing space,
and an unset variable all leave the deployment fully writable, and nothing is
logged to say a value was seen and rejected. Write `YOPEDIA_READONLY=1`, and
leave the quotes off. Compose v2 strips surrounding quotes from `.env`, so
`YOPEDIA_READONLY="1"` happens to work on the deployment this document
describes — but legacy `docker-compose` v1 and `docker run --env-file` do not
strip them, and there the quoted form reads as off.

**Almost everything a reader does still works.** Browsing pages, search and
query answering are untouched: the flag refuses writes, not requests. The chat
API is ungated too, but the Workbench chat canvas reads the flag and disables
its composer — the textarea, the Send button and the composer tools — so chat
is answerable everywhere except there. **Most** refused controls carry a
standing explanatory sentence beside them — "…while this deployment is
read-only" — rather than failing for no stated reason; a few, including Todos,
lint auto-fix and that chat composer, are simply disabled with no read-only
text.

**Refused for every caller, HTTP or not.** These refusals live in the library, so
they hold no matter who reaches them — a REST route, the stdio MCP server, the
CLI, an agent, ingest, lint-fix, merge, or a maintenance script calling straight
into `src/lib`. They cover every page create, edit, revert, delete and metadata
patch, and every Schema (artifact) save; creating, renaming, deleting,
re-templating and switching Wikis; every write to a file inside a Wiki's own
directory, including the Workspace Purpose profile; research projects and
research runs; Names & Terms entries; the email-ingestion settings; Todos; the
Review queue; marking a source as a meeting; and dismissing a Graph Insight. The
four kernel writers `writeWikiPageWithSideEffects`, `deleteWikiPage`,
`patchMetadata` and `writeWikiArtifact` were the *starting* set, not the whole
of it — the wiki-lifecycle writers and the stores listed above assert the same
refusal today. An HTTP caller reading one of these gets **403** with the refusal
sentence as the JSON `error`; a CLI, MCP, agent or library caller gets that same
sentence thrown as an error instead of a status code.

**Refused at the HTTP door as well.** Most of the writes above *also* carry a
check at their own route, so the refusal arrives before an upload is staged, a
`raw/` snapshot is written or an LLM call is spent — the two lists are not
disjoint, and seeing an item in both means it is refused twice over rather than
that one entry is a mistake. The following are gated on the HTTP path **only**
— the route is the one place the check is spelled, so what a non-HTTP caller
meets depends on whether the work happens to end at a writer that refuses:
saving Settings (`PUT /api/settings`), the Settings **Rebuild Vector Index**
button (`POST /api/settings/rebuild-embeddings`), the part of the ingest family
that is not covered above (`POST /api/extract/jobs`, the Workbench `intake`,
`source` and `activity` doors, and the v1 project source rescan), saving an
answer as a page from **either** Query or Chat, lint auto-fix from either the
page view or the Workbench, and both `/api/tasks` doors.

**Still writable — and this is where an operator gets hurt.** The flag is not a
backup, and three of the four administrative doors are ungated.
`POST /api/admin/reset` still deletes `wiki/`, `raw/`, `discuss/` and `tenants/`
outright. `POST /api/archive/import` still writes a whole archive over the wiki
— and that is the door the documented `sync push --confirm` restore drives, so a
restore against a "read-only" deployment succeeds and overwrites.
`POST /api/admin/migrate` still runs the tenant migration. The fourth admin
door is the exception, so the surface is not uniformly open:
`DELETE /api/admin/tenant/[handle]` **is** refused — `deleteTenant` asserts
before it lists or deletes anything, and the route answers 403. Beyond those:
vaults and vault page membership, agent skills, agent tokens, chat
conversations and their messages, query history, action items, integrations and
the integration outbox, source monitors and monitor digests, structured
knowledge and the graph (dismissing an insight is the one exception), the
queue's enqueue side, backups, the operation ledger, the revision store, `raw/`
snapshots and the ingest ledger all still write. Vaults, agent skills and the
archive restore are called out in `src/lib/read-only.ts` as this flag's
*deliberate* boundary and are pinned there by test, so their silence is a
decision rather than an oversight. Two things split rather than land on one
side. Memory change proposals split by action: raising one still writes, and so
do **reject** and **revise**, but **accepting** one is refused, because
`applyMemoryChangeProposal` writes the page through a kernel writer before it
marks the proposal accepted — the refusal leaves the proposal pending and
nothing committed. Agent profiles split mid-route: **seeding** an agent is
refused, because `seedAgent` writes its identity pages through a kernel writer
before the profile is registered, while **editing** an agent that adds no
pages — a name, description, trigger, instructions, default vault or a page
removal — and **deleting** an agent are not refused. One escape hatch is
deliberate in the other direction: `POST /api/admin/rebuild-embeddings` is
service-token only and carries no read-only gate, so the embedding rebuild
prescribed as the drift remedy in the embedding-provider notes above is still
available even though the Settings button beside it refuses.

**`POST /api/tasks/scan` answers 403 on every cron pass.** The body is
`{"error": "Maintenance scans cannot run while this deployment is read-only."}`,
and the gate sits ahead of the `?dry=1` branch, so the documented inspection
switch is refused too rather than degrading to a `dry`-shaped 200 that would
report a scan which never ran. Two consequences worth planning for. Nothing in
the deployment raises an alarm about this by itself: the bundled consumer's cron
is `"0 6 * * *"` — once a day — and its scheduled handler only logs the status
it got back rather than failing, so the alert has to come from an external
monitor watching the endpoint or the log stream. Such a monitor, treating any
non-2xx as a failure, then **fails on every pass** for as long as the flag is
set: once a day on the shipped schedule, once per tick on whatever cadence you
run. And the work this scan alone drives simply stops: the Workspace Purpose
backfill, the orphan wiki-directory sweep, the derived-index self-heal,
the terminal ingest-job garbage collection, and the scheduled-agent,
source-monitor, monitor-digest, integration-outbox and owner-backup passes. The
stores behind the last five are in the still-writable list above, so nothing
refuses their writes — nothing is asking for them. The sweep and the backfill
carry refusals of their own, but the scan is refused long before it calls
either.

**`POST /api/tasks/run` refuses with its own sentence, and the queued work is
retried rather than dropped.** The body is
`{"error": "Queued work cannot run while this deployment is read-only."}` — a
different sentence from the scan's, so an alert rule matching the scan's text
will never fire on the consumer. The task consumer acknowledges and discards a
message only on `400`, `404` and `422`; a **403 falls into its transient branch
and is retried**, up to four delivery attempts, after which the message is parked
in the dead-letter queue. Queued work is therefore replayable, not lost. The cost
is noise rather than loss: every queued message burns its retries against a
deployment that cannot succeed, and on the final attempt an email-origin ingest
sends its submitter a *failure* receipt for what is only a paused deployment.
Pausing the producer, or draining the queue, before setting the flag avoids
both.

**It is a gate, not a deployment-wide write lock.** Every refusal above exists
because some function or route spells the check; a writer added tomorrow is
writable until it does. Read the lists here as the boundary as it stands today,
and re-check it after an upgrade rather than assuming coverage. If what you want
is a genuine write lock, that is a read-only container filesystem or a read-only
volume mount, not this variable.

## Volume Mounts

The compose file defines two named volumes:

| Volume | Container Path | Purpose |
|---|---|---|
| `wiki-data` | `/app/wiki` | Generated wiki markdown pages |
| `raw-data` | `/app/raw` | Ingested source documents |

Your wiki data lives in these volumes and persists even if you remove the container.

For an off-container copy — one-off pulls, scheduled snapshots, and the
two-step restore — use the [local sync companion](tools/work-wiki-sync.md).
Point `WORKWIKI_URL` at your own deployment before you run it: the companion
defaults to `https://workwiki.app`, so a self-hoster who skips that variable
pulls from the hosted instance rather than from this container.

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

That variable is the **chat / generation** endpoint. If you also embed with
Ollama, save the same URL as the **Embedding endpoint** under Settings →
Embeddings — see [Additional Settings](#additional-settings) for why the two are
separate and what happens if you leave it blank.

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
