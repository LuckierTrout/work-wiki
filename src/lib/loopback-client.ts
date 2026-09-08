/**
 * One authenticated fetch for every browser call to 127.0.0.1:19828.
 *
 * Chat, Skills, and workspace Preview used to each read
 * `/api/v1/loopback-settings` and attach Bearer themselves. Three copies is
 * two chances to forget the header — Preview already did, once.
 */

import { send } from "./workbench-request";

let cachedToken: string | null | undefined;

export async function readLoopbackDoorToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  try {
    const settings = await send<{ token?: string | null }>(
      "/api/v1/loopback-settings",
      { method: "GET" },
    );
    cachedToken = typeof settings.token === "string" ? settings.token : null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

export function clearLoopbackDoorToken(): void {
  cachedToken = undefined;
}

export async function loopbackFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await readLoopbackDoorToken();
  const headers = headersRecord(init.headers);
  if (token && !headers.authorization && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(input, { ...init, headers });
}

function headersRecord(init?: HeadersInit): Record<string, string> {
  if (!init) return {};
  if (init instanceof Headers) return Object.fromEntries(init.entries());
  if (Array.isArray(init)) return Object.fromEntries(init);
  return { ...init };
}
