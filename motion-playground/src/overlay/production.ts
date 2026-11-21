import type { SrtLine } from "./srt.ts";

export interface Subtitle {
  name: string;
  relative: string;
  path: string;
  sha256: string;
  count: number;
  start: number;
  end: number;
}

export interface Production {
  root: string;
  name: string;
  agent: string;
  edited: string;
  broll: string;
  subtitles: Subtitle[];
  rules: string[];
}

export type OutputDirectory = { destinationId: string; path: string };
export type SubtitleOutput = OutputDirectory & {
  subtitle: Subtitle;
  agent: string;
  writable: boolean;
};
export type DesktopHost = EventTarget & { postMessage: (message: object) => void };

export interface ProductionContext {
  subtitleOutput?: OutputDirectory;
  directory: Production;
  subtitle: Subtitle | null;
}

export interface HandoffRead {
  text: string;
  identity: string;
  subtitle: Subtitle;
  lines: SrtLine[];
}

export function productionRequest<T>(action: string, data: object): Promise<T> {
  return localRequest(`/api/production/${action}`, data);
}

export function subtitleOutputRequest<T>(action: string, destinationId: string, data?: object): Promise<T> {
  return localRequest(`/api/subtitle-output/${action}`, { ...data, destinationId });
}

async function localRequest<T>(url: string, data: object): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("请通过本机启动器打开工作台。");
  }
  if (!response.ok) {
    const result = await response.json() as { error?: string };
    throw new Error(result.error || "本机目录操作失败");
  }
  return await response.json() as T;
}
