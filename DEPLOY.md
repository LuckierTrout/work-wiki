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
| `EMBEDDING_MODEL` | Override the embedding model name — must use `@cf/` exactly when the embedding provider is `workers-ai` (see below) | Provider default |
| `PORT` | Server port inside the container | `3000` |

**`EMBEDDING_PROVIDER=workers-ai` requires the Cloudflare Workers runtime.** The
provider reaches Cloudflare through the `AI` binding declared in
`wrangler.jsonc`, which does not exist in the Docker/compose deployment this
document describes. Off Workers the binding resolves to nothing and the override
is dropped **silently** — embeddings are then disabled entirely, with no error in
the logs. On Docker, set this to `openai`, `google`, or `ollama`, or leave it
unset and let the app auto-detect.

Those are not safe answers by themselves, though: `openai` and `google` are
dropped just as silently when the matching key is missing (`OPENAI_API_KEY` /
`GOOGLE_GENERATIVE_AI_API_KEY`, or the key stored in Settings → Embeddings).
Forcing a provider also switches OFF the auto-detection fallback, so an override
that cannot resolve leaves embeddings disabled rather than picking a provider
that would have worked. Set the variable only alongside the credential it needs.

**`EMBEDDING_MODEL` must respect the Workers AI namespace boundary.** Cloudflare
Workers AI model ids live in the `@cf/` namespace (`@cf/baai/bge-m3`,
`@cf/baai/bge-large-en-v1.5`); every other embedding provider's ids must sit
outside it. This check does not validate one non-Workers-AI provider's model
catalog against another's. Two separate things happen to an id on the wrong side
of the boundary:

- **The Workbench Settings surface refuses it.** The vector-search switch in the
  Workbench's Embeddings settings cannot be turned on while the model id and the
  **explicitly selected** embedding provider disagree, and a save that tries is
  rejected with a message naming the namespace it expected. Two limits are worth
  knowing before you rely on it. The older `/settings` page saves the embedding
  model through a flat request that never runs this check, so a mismatch entered
  there is accepted silently. And the namespace is only named once an embedding
  provider has actually been chosen — with the provider left to auto-detection
  the switch refuses for the missing provider instead, and never mentions `@cf/`
  at all.
- **The embedding path substitutes the provider default.** The mismatched id is
  ignored and embedding continues with the default for the resolved provider
  (`@cf/baai/bge-m3` for Workers AI, `text-embedding-3-small` for OpenAI,
  `gemini-embedding-001` for Google, `nomic-embed-text` for Ollama), so content
  is still embedded — just not with the model named here.

That substitution is the expensive half. Different embedding models generally
produce vectors of different widths, and every stored vector is tagged with the
model that produced it. Once a store holds vectors from two models, queries
either fail outright on a dimension mismatch or have every hit discarded by the
model filter — either way vector search returns nothing until the whole corpus
is re-embedded. So a mismatch does not stop embeddings; it silently changes
which model does them, and can cost you the index you already built. If the
model you set here does not appear to be in use, check that it is on the same
side of the `@cf/` boundary as the selected embedding provider.

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
