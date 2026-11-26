import { useEffect, useRef, useState } from "react";
import { handoffPrompt, parseHandoff, parsePickedOverlay } from "../overlay/handoff";
import { productionRequest, subtitleOutputRequest, type DesktopHost, type HandoffRead, type Production, type ProductionContext, type SubtitleOutput } from "../overlay/production";
import { draftTime, type SavedDraft } from "../overlay/useLocalDraft";
import type { SrtLine } from "../overlay/srt";
import type { OverlayDoc } from "../overlay/types";
import type { Aspect } from "../stage";

interface Props {
  desktopHost?: DesktopHost;
  hasEditor: boolean;
  savedDraft: SavedDraft | null;
  applied: string | null;
  onResume: () => void;
  onManual: (context: ProductionContext | null, aspect: Aspect, video: File | null, lines: SrtLine[] | null) => void;
  onApply: (context: ProductionContext | null, draft: OverlayDoc, lines: SrtLine[] | null, identity: string, video: File | null, warnings?: string[]) => boolean;
  onImport: (file: File, context: ProductionContext | null, video: File | null, lines: SrtLine[] | null) => Promise<void>;
  onDemo: () => void;
  onRestore: () => void;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const PICKED_SUBTITLE = "picked";

type Candidate = ReturnType<typeof parseHandoff> & {
  identity: string;
  lines: SrtLine[] | null;
  file?: File;
  verified: boolean;
};

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取所选 SRT。"));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}

// 与固定路径读取共用同一身份，避免从文件选择器重读时覆盖已应用的手调稿。
async function pickedIdentity(root: string, bytes: ArrayBuffer) {
  const prefix = new TextEncoder().encode(root + "\0");
  const input = new Uint8Array(prefix.length + bytes.byteLength);
  input.set(prefix);
  input.set(new Uint8Array(bytes), prefix.length);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function Preparation(props: Props) {
  const [input, setInput] = useState("");
  const [directory, setDirectory] = useState<Production | null>(null);
  const [imported, setImported] = useState<Production | null>(null);
  const [subtitleOutput, setSubtitleOutput] = useState<SubtitleOutput>();
  const [relative, setRelative] = useState("");
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [brief, setBrief] = useState("");
  const [media, setMedia] = useState("");
  const [video, setVideo] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [subtitleError, setSubtitleError] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState(false);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const importFile = useRef<HTMLInputElement>(null);
  const subtitleFile = useRef<HTMLInputElement>(null);
  const candidateFile = useRef<HTMLInputElement>(null);
  const promptField = useRef<HTMLTextAreaElement>(null);
  const output = imported && !directory ? subtitleOutput : undefined;
  const subtitle = output?.subtitle ?? imported?.subtitles[0] ?? directory?.subtitles.find((item) => item.relative === relative) ?? null;
  const handoffDirectory = output && imported
    ? { ...imported, root: output.path, agent: output.agent }
    : directory ?? imported;
  const context = handoffDirectory && (directory || output)
    ? { directory: handoffDirectory, subtitle, subtitleOutput: output } : null;
  const handoffIdentity = output ? `${output.path}\0${output.subtitle.path}` : handoffDirectory?.root ?? "";
  const subtitleRoot = (imported ?? directory)?.root;
  const awaitingDirectory = !!input.trim() && !directory;
  const prompt = !awaitingDirectory && handoffDirectory && output?.writable !== false
    ? handoffPrompt({ directory: handoffDirectory, subtitle }, aspect, brief, [video?.name, media].filter(Boolean).join("；"), !!imported)
    : "";

  const clearResult = () => {
    setCandidate(null);
    setCopied(false);
    setStatus("");
    setError("");
    setSubtitleError("");
  };

  useEffect(() => {
    const host = props.desktopHost;
    if (!host) return;
    const onPick = (event: Event) => {
      const data = (event as MessageEvent).data;
      if (data?.type === "subtitle-directory-picked") {
        setBusy(false);
        if (data.status === "selected") {
          setSubtitleOutput(data.result);
          clearResult();
        } else if (data.status === "error") setSubtitleError(data.error);
        return;
      }
      if (data?.type !== "subtitle-picked") return;
      setBusy(false);
      if (data.status === "selected") {
        setImported(data.result.production);
        setSubtitleOutput(data.result.output);
        setCandidate(null);
        setCopied(false);
        setStatus("");
        setError("");
      } else if (data.status === "error") {
        setSubtitleError(data.error);
      }
    };
    host.addEventListener("message", onPick);
    return () => host.removeEventListener("message", onPick);
  }, [props.desktopHost]);

  const selectSubtitle = () => {
    if (!props.desktopHost) {
      subtitleFile.current?.click();
      return;
    }
    setSubtitleError("");
    setBusy(true);
    props.desktopHost.postMessage({ type: "select-subtitle" });
  };

  const inspect = async () => {
    clearResult();
    setBusy(true);
    try {
      const next = await productionRequest<Production>("inspect", { root: input.trim().replace(/^"|"$/g, "") });
      setRelative(next.subtitles.length === 1 ? next.subtitles[0].relative
        : next.root === directory?.root && next.subtitles.some((item) => item.relative === relative) ? relative : "");
      setDirectory(next);
      setInput(next.root);
    } catch (cause) {
      setDirectory(null);
      setRelative("");
      setSubtitleError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const importSubtitle = async (file: File) => {
    setBusy(true);
    setSubtitleError("");
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("SRT 文件不能超过 10 MB。");
      const next = await productionRequest<Production>("import-srt", { name: file.name, base64: await readBase64(file) });
      setImported(next);
      setSubtitleOutput(undefined);
      clearResult();
    } catch (cause) {
      setSubtitleError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectOutputDirectory = () => {
    if (!output || !props.desktopHost) return;
    setSubtitleError("");
    setBusy(true);
    props.desktopHost.postMessage({ type: "select-subtitle-directory", destinationId: output.destinationId });
  };

  const nextRound = async () => {
    if (!output) return;
    setBusy(true);
    try {
      setSubtitleOutput(await subtitleOutputRequest<SubtitleOutput>("next", output.destinationId));
      clearResult();
      setStatus("已切换到新的交稿文件，请重新复制指令。");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!prompt) return;
    setError("");
    try {
      await navigator.clipboard.writeText(prompt);
      setStatus("指令已复制。粘贴到 Codex 或 Claude Code，完成后回来读取。");
    } catch {
      setShowPrompt(true);
      setStatus("请选中下方指令并手动复制。");
    }
    setCopied(true);
  };

  const readSelectedLines = async () => {
    if (output) return (await subtitleOutputRequest<{ lines: SrtLine[] }>("lines", output.destinationId)).lines;
    if (!subtitleRoot || !subtitle) return null;
    const result = await productionRequest<{ lines: SrtLine[] }>("subtitle", {
      root: subtitleRoot, subtitle: subtitle.relative, sha256: subtitle.sha256,
    });
    return result.lines;
  };

  const read = async (apply = false, file?: File) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      let draft: Candidate;
      if (file) {
        const bytes = await file.arrayBuffer();
        // 旧手选稿的交接路径指向临时目录中的 Word/ 副本。
        const parsed = parsePickedOverlay(new TextDecoder().decode(bytes), subtitle, aspect,
          output ? imported?.subtitles[0] : undefined);
        const lines = await readSelectedLines();
        const identity = await pickedIdentity(handoffIdentity, bytes);
        draft = { ...parsed, identity, lines, file };
      } else {
        if (!handoffDirectory || !subtitle) return;
        const result = output ? await subtitleOutputRequest<HandoffRead>("read", output.destinationId)
          : await productionRequest<HandoffRead>("read", {
            root: handoffDirectory.root, subtitleRoot: imported?.root, subtitle: subtitle.relative, sha256: subtitle.sha256,
          });
        draft = { ...parseHandoff(result.text, result.subtitle, aspect), identity: result.identity, lines: result.lines, verified: true };
      }
      setCandidate(draft);
      if (draft.identity === props.applied) {
        setStatus("这份编排已应用，当前编辑内容已保留。");
      } else if (apply && candidate?.identity !== draft.identity) {
        setStatus("交稿文件已更新，请核对这份候选后再确认。");
      } else if (apply && props.onApply(context, draft.doc, draft.lines, draft.identity, video, draft.warnings)) {
        setStatus("已应用到时间轴。");
      }
    } catch (cause) {
      setCandidate(null);
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const openForEditing = async (file?: File) => {
    setBusy(true);
    setError("");
    try {
      const lines = await readSelectedLines();
      if (file) await props.onImport(file, context, video, lines);
      else props.onManual(context, aspect, video, lines);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="production-prep" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (!busy && !awaitingDirectory && file?.name.toLowerCase().endsWith(".json")) void openForEditing(file);
    }}>
      <header className="production-heading">
        <h1>准备这一期视频</h1>
        <nav aria-label="其他入口">
          {props.hasEditor && <button disabled={busy} onClick={props.onResume}>返回编辑台</button>}
          <button disabled={busy || awaitingDirectory} onClick={() => void openForEditing()}>手动编排</button>
          <button disabled={busy || awaitingDirectory} onClick={() => importFile.current?.click()}>导入已有编排</button>
          <button disabled={busy} onClick={props.onDemo}>打开示例</button>
          {props.savedDraft && <button disabled={busy} onClick={props.onRestore}>
            恢复上次草稿 · {props.savedDraft.project.name}
            {props.savedDraft.savedAt ? ` · ${draftTime(props.savedDraft.savedAt)}` : ""}
          </button>}
          <input ref={importFile} hidden type="file" accept=".json,application/json" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void openForEditing(file);
          }} />
        </nav>
      </header>
      <fieldset className="production-grid" disabled={busy}>
        <section className="production-panel">
          <h2>本期目录与素材</h2>
          <form className="production-path" onSubmit={(event) => { event.preventDefault(); void inspect(); }}>
            <label>制作根目录
              <input value={input} placeholder="粘贴本期目录的完整路径" onChange={(event) => {
                setInput(event.target.value);
                setDirectory(null);
                setRelative("");
                clearResult();
              }} />
            </label>
            <button className={!directory ? "production-primary" : ""} disabled={!input.trim()}>
              {directory ? "重新扫描字幕" : "读取目录"}
            </button>
            <button type="button" onClick={selectSubtitle}>选择 SRT 文件</button>
            <input ref={subtitleFile} hidden type="file" accept=".srt" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importSubtitle(file);
            }} />
          </form>
          {subtitleError && <p className="production-error" role="alert">{subtitleError}</p>}
          {awaitingDirectory && <small>先读取已填写的目录，或清空路径后直接开始。</small>}
          {directory && <div className="production-meta"><strong>{directory.name}</strong><small>{directory.root}</small></div>}
          <label>画幅
            <select value={aspect} onChange={(event) => { setAspect(event.target.value as Aspect); clearResult(); }}>
              <option value="9:16">竖屏 9:16</option><option value="16:9">横屏 16:9</option>
            </select>
          </label>
          <div className="production-field">
            <label>口播字幕
              {(imported || !!directory?.subtitles.length) && <select value={imported ? PICKED_SUBTITLE : relative} onChange={(event) => {
                setImported(null);
                setRelative(event.target.value);
                clearResult();
              }}>
                <option value="" disabled={!imported}>{imported ? "取消手选字幕" : "请选择字幕"}</option>
                {imported && <option value={PICKED_SUBTITLE}>{subtitle?.name}（手选）</option>}
                {directory?.subtitles.map((item) => <option key={item.relative} value={item.relative}>{item.name}</option>)}
              </select>}
            </label>
            {subtitle ? <small>{subtitle.count} 条 · {subtitle.start}–{subtitle.end} 秒</small>
              : directory && !directory.subtitles.length && <p>可选择 SRT 文件，或将字幕放入 Word 文件夹后重新扫描。</p>}
            {output ? <>
              <small>输出目录：{output.path}</small>
              <button type="button" onClick={selectOutputDirectory}>选择输出目录</button>
              {!output.writable && <p className="production-error" role="alert">当前目录不可写，请另选输出目录。</p>}
            </> : imported && !directory && <p>浏览器模式使用临时字幕副本和临时交稿目录。</p>}
          </div>
          <label>源视频（可选）
            <input type="file" accept="video/*,.mov,.m4v" onChange={(event) => {
              setVideo(event.target.files?.[0] ?? null);
              setCopied(false);
            }} />
          </label>
          <label>已知素材位置（可选）
            <input value={media} onChange={(event) => { setMedia(event.target.value); setCopied(false); }} />
          </label>
          <label>本期要求（可选）
            <textarea rows={2} value={brief} onChange={(event) => { setBrief(event.target.value); setCopied(false); }} />
          </label>
        </section>
        <section className="production-panel">
          <h2>交给 Agent 编排</h2>
          <ol>
            <li>
              <strong>复制给 Agent</strong>
              <p>把指令粘贴到 Codex 或 Claude Code。</p>
              {!awaitingDirectory && subtitle && handoffDirectory && <p>交稿路径：{handoffDirectory.agent}</p>}
              <div className="production-actions">
                <button className={subtitle && !copied && !candidate ? "production-primary" : ""} disabled={!prompt} onClick={copy}>复制给 Agent</button>
                <button disabled={!prompt} onClick={() => setShowPrompt(!showPrompt)}>{showPrompt ? "收起指令" : "查看指令"}</button>
                {output && <button disabled={!output.writable} onClick={() => void nextRound()}>新一轮编排</button>}
              </div>
              {showPrompt && prompt && <textarea ref={promptField} aria-label="Agent 指令" readOnly rows={7} value={prompt} onFocus={() => promptField.current?.select()} />}
            </li>
            <li>
              <strong>读取编排结果</strong>
              <p>Agent 交稿后，在这里核对字幕、卡数和待补项。</p>
              <div className="production-actions">
                <button className={copied && !candidate ? "production-primary" : ""} disabled={awaitingDirectory || !subtitle} onClick={() => void read()}>读取编排结果</button>
                <button onClick={() => candidateFile.current?.click()}>选择 JSON 文件</button>
                <input ref={candidateFile} hidden type="file" accept=".json,application/json" onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void read(false, file);
                }} />
              </div>
            </li>
          </ol>
          {candidate && <section className="production-field production-result">
            <strong>编排候选稿</strong>
            <p>{candidate.file?.name ?? subtitle?.name} · {candidate.doc.aspect} · {candidate.doc.cards.length} 张动效卡</p>
            {!candidate.verified && <p>这份编排未核对字幕，请确认内容适合本期。</p>}
            {!!candidate.warnings?.length && <ul>{candidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            {candidate.missing.length ? <ul>{candidate.missing.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>无待补项</p>}
            <button className="production-primary" disabled={awaitingDirectory || candidate.identity === props.applied} onClick={() => void read(true, candidate.file)}>应用到时间轴</button>
          </section>}
          {status && <p className="production-status" role="status">{status}</p>}
          {error && <p className="production-error" role="alert">{error}</p>}
        </section>
      </fieldset>
    </main>
  );
}
