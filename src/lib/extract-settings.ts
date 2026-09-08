/**
 * The Intake and MinerU PDF panes' stored shape (Stories 7.2 and 7.5).
 *
 * ONE STORE. These ride in the same `AppConfig` object `saveConfig` writes —
 * AD-23 names the kernel store, and a second settings file for extract would
 * be the retrofitted-config-store trap `.yoyo/learnings.md` records: the UI
 * saves happily and the reader keeps consulting its old source. The readers
 * here are the only readers, and they read `loadConfig`.
 *
 * The INBOUND EMAIL ADDRESS is deliberately NOT here. It already lives in
 * `./email-ingest`'s own index, which the inbound Worker's route and the legacy
 * `/settings` page both use; the Workbench Intake pane renders that value
 * rather than minting a second copy of it to drift against.
 */

import { loadConfig } from "./config";
import {
  MINERU_DEFAULT_LOCAL_BASE_URL,
  isMinerUMode,
  type MinerUMode,
} from "./workbench-settings";

export interface MinerUSettings {
  mode: MinerUMode;
  /** Base URL for `local` mode. Ignored by every other mode. */
  localBaseUrl: string;
  /** True when a Cloud/Pipeline credential is stored. Never the key itself. */
  apiKeyConfigured: boolean;
}

export interface IntakeSettings {
  /** Keep the extractor's Markdown under `raw/parsed/` as well. */
  keepParsed: boolean;
}

function normalizeMode(value: unknown): MinerUMode {
  return isMinerUMode(value) ? value : "off";
}

/**
 * The MinerU configuration in effect.
 *
 * `off` is what an absent, malformed or unrecognised stored value resolves to.
 * That is the fail-closed direction for a setting whose non-default modes can
 * send an owner's documents to a third party.
 */
export async function getMinerUSettings(): Promise<MinerUSettings> {
  const config = await loadConfig();
  return {
    mode: normalizeMode(config.mineruMode),
    localBaseUrl:
      typeof config.mineruLocalBaseUrl === "string" && config.mineruLocalBaseUrl.trim()
        ? config.mineruLocalBaseUrl.trim()
        : MINERU_DEFAULT_LOCAL_BASE_URL,
    apiKeyConfigured: Boolean(config.mineruApiKey?.trim()),
  };
}

export async function getIntakeSettings(): Promise<IntakeSettings> {
  const config = await loadConfig();
  return { keepParsed: config.intakeKeepParsed === true };
}

/**
 * What the sidecar is told about MinerU when it claims a job.
 *
 * The API KEY IS INCLUDED, and only on this path: the sidecar is a process on
 * the owner's own machine authenticating with the owner-automation token, and
 * it is the process that would make the MinerU call. Nothing browser-facing
 * reads this function — {@link getMinerUSettings} is what the pane gets, and it
 * reports only whether a key exists.
 */
export async function getMinerUExtractorConfig(): Promise<{
  mode: MinerUMode;
  localBaseUrl: string;
  apiKey: string;
}> {
  const config = await loadConfig();
  const settings = await getMinerUSettings();
  return {
    mode: settings.mode,
    localBaseUrl: settings.localBaseUrl,
    apiKey: config.mineruApiKey?.trim() ?? "",
  };
}
