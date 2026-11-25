import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OverlayDoc } from "./types";
import type { SrtLine } from "./srt";

const DRAFT_KEY = "overlayStudioAutosave";

export interface DraftProject {
  id: string;
  name: string;
}

interface DraftSnapshot {
  project: DraftProject;
  overlay: OverlayDoc;
  origin: OverlayDoc | null;
  srt: SrtLine[] | null;
  videoUrl?: string;
}

export interface SavedDraft extends Omit<DraftSnapshot, "overlay"> {
  overlay?: OverlayDoc;
  revision: number;
  savedAt?: string;
}

function parseDraft(raw: string | null): SavedDraft | null {
  let saved;
  try { saved = JSON.parse(raw ?? "null"); } catch { return null; }
  if (!saved || (!Array.isArray(saved.overlay?.cards) && !Array.isArray(saved.srt) &&
    !(typeof saved.videoUrl === "string" && saved.videoUrl.startsWith("/_media/")))) return null;
  return {
    ...saved,
    project: {
      id: typeof saved.project?.id === "string" ? saved.project.id : "legacy",
      name: (typeof saved.project?.name === "string" && saved.project.name.trim())
        || "本机草稿",
    },
    revision: Number.isSafeInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0,
    savedAt: typeof saved.savedAt === "string" && Number.isFinite(Date.parse(saved.savedAt))
      ? saved.savedAt : undefined,
  };
}

export function readDraft() {
  const raw = localStorage.getItem(DRAFT_KEY);
  return { raw, saved: parseDraft(raw) };
}

export function draftTime(savedAt: string) {
  return new Date(savedAt).toLocaleString("zh-CN", { hour12: false });
}

type PendingDraft = DraftSnapshot & { revision: number };
type DraftStatus = "saving" | "saved" | "failed" | "conflict" | null;

export function useLocalDraft(snapshot: DraftSnapshot | null, pristineManual = false) {
  const [record, setRecord] = useState(() => {
    try { return readDraft(); } catch { return null; }
  });
  const saved = record?.saved ?? null;
  // 保留本标签页读取或写入过的版本。修订号在两个标签页中可能相同。
  const expectedRaw = useRef(record?.raw);
  const [status, setStatus] = useState<DraftStatus>(null);
  const revision = useRef(saved?.revision ?? 0);
  const restored = useRef<DraftSnapshot | null>(null);
  const pending = useRef<PendingDraft | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const flush = (): boolean => {
    window.clearTimeout(timer.current);
    const attempt = pending.current;
    if (!attempt) return true;
    try {
      const current = localStorage.getItem(DRAFT_KEY);
      if (current !== (expectedRaw.current ?? null)) {
        setRecord({ raw: current, saved: parseDraft(current) });
        setStatus("conflict");
        return false;
      }
      const written = { ...attempt, savedAt: new Date().toISOString() };
      const raw = JSON.stringify(written);
      localStorage.setItem(DRAFT_KEY, raw);
      expectedRaw.current = raw;
      pending.current = null;
      setRecord({ raw, saved: written });
      setStatus("saved");
      return true;
    } catch {
      setStatus("failed");
      return false;
    }
  };

  const cancel = () => {
    window.clearTimeout(timer.current);
    pending.current = null;
    restored.current = null;
    setStatus(null);
  };

  const discard = (projectId: string) => {
    try {
      const current = readDraft();
      if (current.raw === expectedRaw.current && current.saved?.project.id === projectId) {
        localStorage.removeItem(DRAFT_KEY);
        expectedRaw.current = null;
        setRecord({ raw: null, saved: null });
      } else {
        setRecord(current);
      }
      cancel();
      return true;
    } catch {
      return false;
    }
  };

  const resume = (snapshot: DraftSnapshot, saved: SavedDraft, raw: string | null) => {
    restored.current = snapshot;
    revision.current = Math.max(revision.current, saved.revision);
    expectedRaw.current = raw;
    setRecord({ raw, saved });
    setStatus("saved");
  };

  const preservePrevious = pristineManual && saved?.project.id !== snapshot?.project.id;
  useLayoutEffect(() => {
    if (!snapshot || preservePrevious) {
      if (pending.current) cancel();
      return;
    }
    const baseline = restored.current;
    if (baseline?.project === snapshot.project && baseline.overlay === snapshot.overlay &&
      baseline.origin === snapshot.origin && baseline.srt === snapshot.srt && baseline.videoUrl === snapshot.videoUrl) return;
    restored.current = null;
    const attempt = { ...snapshot, revision: ++revision.current };
    pending.current = attempt;
    setStatus("saving");
    timer.current = window.setTimeout(() => {
      if (pending.current === attempt) flush();
    }, 800);
    return () => window.clearTimeout(timer.current);
  }, [snapshot, preservePrevious]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  return { saved, status, flush, cancel, discard, resume };
}
