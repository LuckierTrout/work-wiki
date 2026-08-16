# Yopedia sandbox runner

This is a separate Cloudflare Worker + Container boundary for agent code
execution. The main work-wiki Worker sends only a command and explicitly supplied
files; no Clerk, R2, LLM, or provider credentials are mounted in the container.

Before deployment, create the shared secret with:

```sh
pnpm install
pnpm wrangler secret put YOPEDIA_SANDBOX_TOKEN
pnpm deploy
```

Then configure the same value as the `YOPEDIA_SANDBOX_TOKEN` secret on the main
`yopedia` Worker. The main Worker uses the private
`YOPEDIA_SANDBOX` service binding in `wrangler.jsonc`; no public route or custom
domain is required. `YOPEDIA_SANDBOX_URL` remains an optional local-development
fallback. Grant an individual agent the `run-sandbox` tool only when it needs
isolated calculation or file transformation.
