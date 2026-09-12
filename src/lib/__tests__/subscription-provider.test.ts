import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSubscriptionChat, subscriptionCommand, subscriptionEnv, subscriptionText } from "../../../sidecar/subscription-provider.mjs";
import { generateChat } from "../../../sidecar/chat-provider.mjs";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "subscription-provider-test-"));
  // Real subprocesses, but no external provider calls. The fixture also tests
  // the argv/stdin/env contract at the process boundary, including UTF-8 splits.
  const fixture = `#!${process.execPath}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
process.stdin.on('end',()=>{
 if(input.includes('WAIT_FOREVER')){setInterval(()=>{},1000);return;}
 if(input.includes('OVERFLOW')){process.stdout.write('x'.repeat(1100000));return;}
 const text=JSON.stringify({args:process.argv.slice(2),input:JSON.parse(input),apiKey:process.env.OPENAI_API_KEY||null,cwd:process.cwd(),unicode:'é'});
 const out=process.argv[1].endsWith('claude')?JSON.stringify([{type:'system'},{type:'result',is_error:false,result:text}]):JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\\n'+JSON.stringify({type:'turn.completed'});
 const bytes=Buffer.from(out);const split=bytes.indexOf(Buffer.from('é'))+1;
 process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.end(bytes.subarray(split)),10);
});`;
  for (const binary of ["claude", "codex"]) await writeFile(path.join(dir, binary), fixture, { mode: 0o700 });
  vi.stubEnv("PATH", dir);
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("OPENAI_API_KEY", "must-not-reach-subscription-client");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

describe("subscription clients", () => {
  it.each(["openai", "anthropic"])("runs %s with separate argv, complete context and no API credentials", async (provider) => {
    const messages = [{ role: "user", content: "$(touch should-not-exist) `echo text` é" }];
    const result = JSON.parse(await generateSubscriptionChat({ provider, model: "safe-model", system: "SYSTEM", messages }));
    expect(result.apiKey).toBeNull();
    expect(result.input).toMatchObject({ system: "SYSTEM", messages });
    expect(result.args).toContain("safe-model");
    expect(result.unicode).toBe("é");
    expect(result.cwd).not.toBe(process.cwd());
    if (provider === "anthropic") {
      expect(result.args).toEqual(expect.arrayContaining(["--restricted", "--tools", "", "--strict-mcp-config", "--no-session-persistence"]));
    } else {
      expect(result.args).toEqual(expect.arrayContaining(["--ignore-user-config", "--ephemeral", "read-only", "features.shell_tool=false", "features.unified_exec=false", 'forced_login_method="chatgpt"']));
    }
  });

  it("routes the actual Chat provider through the saved subscription choice", async () => {
    vi.stubEnv("WORKWIKI_CHAT_TRANSPORT", "subscription");
    await writeFile(path.join(dir, ".llm-wiki-config.json"), JSON.stringify({ chatProvider: "openai" }));
    const result = JSON.parse(await generateChat({ provider: "anthropic", model: "untrusted-model", system: "SYSTEM", messages: [] }));
    expect(result.args[0]).toBe("exec");
    expect(result.args).not.toContain("untrusted-model");
  });

  it("does not fall back to API access for unsupported providers", async () => {
    vi.stubEnv("WORKWIKI_CHAT_TRANSPORT", "subscription");
    await writeFile(path.join(dir, ".llm-wiki-config.json"), JSON.stringify({ chatProvider: "google" }));
    await expect(generateChat({ messages: [] })).rejects.toThrow("supports OpenAI or Anthropic");
  });

  it("strips API credentials and endpoint or OAuth overrides from the child environment", () => {
    expect(subscriptionEnv({ PATH: "/bin", HOME: "/home", OPENAI_API_KEY: "secret", ANTHROPIC_AUTH_TOKEN: "secret", CLAUDE_CODE_OAUTH_TOKEN: "secret", ANTHROPIC_BASE_URL: "https://elsewhere" })).toEqual({ PATH: "/bin", HOME: "/home" });
  });
  it("rejects option-shaped model names", () => {
    expect(() => subscriptionCommand("openai", "--dangerously-bypass-approvals-and-sandbox")).toThrow("Invalid");
  });
  it("rejects partial or unsuccessful provider results", () => {
    expect(() => subscriptionText("openai", '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}')).toThrow("finish");
    expect(() => subscriptionText("anthropic", '{"type":"result","is_error":true,"result":"partial"}')).toThrow("successful");
  });
  it("cancels the child instead of leaving it running", async () => {
    await expect(generateSubscriptionChat({ provider: "openai", messages: [{ role: "user", content: "WAIT_FOREVER" }], signal: AbortSignal.timeout(150) })).rejects.toMatchObject({ name: "TimeoutError" });
  });
  it("bounds process output", async () => {
    await expect(generateSubscriptionChat({ provider: "openai", messages: [{ role: "user", content: "OVERFLOW" }] })).rejects.toThrow("output exceeded");
  });
});
