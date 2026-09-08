import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MINERU_CLOUD_WARNING_COPY,
  MINERU_FIRST_MODE,
  SETTINGS_INTAKE_EMAIL_COPY,
  SETTINGS_INTAKE_FORMATS_COPY,
  SETTINGS_INTAKE_PLAUD_COPY,
  draftMinerULeavesMachine,
  mineruLeavesMachine,
  settingsDraftAfterMinerUEnabled,
  type SettingsDraft,
} from "../workbench-settings";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function draft(mode: SettingsDraft["mineruMode"]): SettingsDraft {
  return { mineruMode: mode } as SettingsDraft;
}

describe("MinerU first enablement and Cloud warning (Story 7.2)", () => {
  it("lands a first enablement on Local API, not Cloud", () => {
    expect(MINERU_FIRST_MODE).toBe("local");
    expect(settingsDraftAfterMinerUEnabled(draft("off"), true).mineruMode).toBe(
      "local",
    );
  });

  it("does not reset Cloud back to Local when the box is already on", () => {
    expect(settingsDraftAfterMinerUEnabled(draft("cloud"), true).mineruMode).toBe(
      "cloud",
    );
  });

  it("treats ONLY Cloud as leaving the machine — Pipeline is the local backend", () => {
    // Read off the implementation, not the name: `sidecar/mineru.mjs` sends
    // `local` and `pipeline` to the SAME `POST /file_parse` on the owner's own
    // server, differing only in a `backend` form field. Warning about an upload
    // that does not happen teaches the owner that the orange sentence does not
    // mean what it says, and then they discount it on the one mode where it is
    // true.
    expect(mineruLeavesMachine("cloud")).toBe(true);
    expect(mineruLeavesMachine("pipeline")).toBe(false);
    expect(mineruLeavesMachine("local")).toBe(false);
    expect(mineruLeavesMachine("off")).toBe(false);
    expect(draftMinerULeavesMachine(draft("cloud"))).toBe(true);
    expect(draftMinerULeavesMachine(draft("pipeline"))).toBe(false);
    expect(draftMinerULeavesMachine(draft("local"))).toBe(false);
  });

  it("keeps the mineru module's own mode routing in agreement with that", async () => {
    // The two halves of the claim above live in different languages, so the
    // sidecar's routing is read here rather than restated: if `pipeline` ever
    // does become a hosted mode, this is the line that notices.
    const sidecar = await readFile(join(ROOT, "sidecar/mineru.mjs"), "utf8");
    expect(sidecar).toMatch(/mode === "local" \|\| mode === "pipeline"/);
    expect(sidecar).toMatch(/runLocal\(/);
  });

  it("names the leave-the-machine warning in one locked sentence", () => {
    expect(MINERU_CLOUD_WARNING_COPY).toBe(
      "Cloud mode uploads documents to MinerU. They leave this machine.",
    );
  });
});

describe("Settings → Intake surface (Story 7.5)", () => {
  it("says inbound-address only, not a connected mailbox or folder-watch", () => {
    expect(SETTINGS_INTAKE_EMAIL_COPY).toMatch(/not a connected mailbox/i);
    expect(SETTINGS_INTAKE_EMAIL_COPY).not.toMatch(/folder-watch|IMAP|mailbox login/i);
  });

  it("renders the inbound address pane without OS folder-watch", async () => {
    const canvas = await readFile(
      join(ROOT, "src/components/workbench/SettingsCanvas.tsx"),
      "utf8",
    );
    expect(canvas).toContain("SETTINGS_INTAKE_EMAIL_COPY");
    expect(canvas).toContain("SETTINGS_INTAKE_EMAIL_LABEL");
    expect(canvas).toContain("SETTINGS_INTAKE_COPY_ADDRESS");
    expect(canvas).not.toMatch(/folder-watch|Source Folder Auto Watch|OS folder/i);
    expect(canvas).toContain("MINERU_CLOUD_WARNING_COPY");
    expect(canvas).toContain("settingsDraftAfterMinerUEnabled");
    expect(canvas).toContain("draftMinerULeavesMachine");
  });
});

describe("the accepted-formats sentence (Story 7.5)", () => {
  it("does not claim email or the API take images and AV", async () => {
    // Both gate on `isSupportedDocument`, whose allowlist is `DOCUMENT_FORMATS`
    // — no image, video or audio member. A mailed PNG is silently counted as a
    // skipped attachment, so an owner reading "mailed in, or posted to the API"
    // over a grid that shows images would conclude their mail was lost.
    const { DOCUMENT_FORMATS } = await import("../document-formats");
    const { INTAKE_MEDIA_EXTENSIONS } = await import("../workbench-intake");
    for (const format of Object.values(INTAKE_MEDIA_EXTENSIONS)) {
      expect(DOCUMENT_FORMATS as readonly string[]).not.toContain(format);
    }
    expect(SETTINGS_INTAKE_FORMATS_COPY).toMatch(/dropped on the Workbench/i);
    expect(SETTINGS_INTAKE_FORMATS_COPY).toMatch(
      /document formats only|images, video and audio arrive by drop/i,
    );
  });
});

describe("Plaud OAuth Block If (Story 7.6)", () => {
  it("does not offer list/pull; the pane names that Plaud publishes no account API", () => {
    expect(SETTINGS_INTAKE_PLAUD_COPY).toMatch(/upload/i);
    expect(SETTINGS_INTAKE_PLAUD_COPY).toMatch(/no account API/i);
    expect(SETTINGS_INTAKE_PLAUD_COPY).not.toMatch(/OAuth list\/pull|Connect Plaud/i);
  });
});
