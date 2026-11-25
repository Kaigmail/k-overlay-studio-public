import { cardGroup, frameOf, moveBox, own, paintCards, placementParams, preserveGroupOrder, resizeBox, writePlacement, SCALE_STEP, type CardLayout } from "./overlay/placement";
import type { CardPlacement } from "./overlay/refinement";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EFFECTS } from "./effects/registry";
import { Preparation } from "./components/Preparation";
import { productionRequest, subtitleOutputRequest, type DesktopHost, type OutputDirectory, type ProductionContext } from "./overlay/production";
import { draftTime, readDraft, useLocalDraft, type DraftProject } from "./overlay/useLocalDraft";
import { Sidebar } from "./components/Sidebar";
import { Canvas } from "./components/Canvas";
import { ParamsPanel } from "./components/ParamsPanel";
import { TimelineBar } from "./components/TimelineBar";
import {
  TopBar,
  FORMS,
  PALETTES,
  LEGACY_SKIN_MAP,
  type StudioTab,
} from "./components/TopBar";
import { parseOverlay, withOverlayCards, type OverlayCard, type OverlayDoc } from "./overlay/types";
import { setStage, aspectOfDoc, type Aspect } from "./stage";
import { frameAtOrBefore, frameTime, isVisibleAt, resolveExport, visibleFrameRange, type ExportPreset } from "./overlay/export-preset";
import { parseSrt, type SrtLine } from "./overlay/srt";
import { lintOverlay, mergeLintConfig, type LintConfig, type LintIssue } from "./overlay/lint";
import { uploadErrText } from "./uploadErr";
import lintDefaults from "../lint-rules.default.json";

// 个人阈值(lint-rules.local.json,gitignore):存在就叠加覆盖公共默认
const lintLocalModules = import.meta.glob("../lint-rules.local.json", { eager: true }) as Record<
  string,
  { default: Partial<LintConfig> }
>;
const LINT_CFG = mergeLintConfig(
  lintDefaults as Partial<LintConfig>,
  Object.values(lintLocalModules)[0]?.default,
);
import "./effects/hud/hud.css";
import "./App.css";
import "./Production.css";

/** 新卡默认多长:整段演示类的卡要 15 秒才够看完一轮,其余 5 秒。
    右栏那颗「加到 x:xx,时长 n 秒」按钮和真正的插入逻辑共用这一个数,
    避免文案说 5 秒、插进去却是别的。 */
function addSecFor(kind: string) {
  return kind === "focus-card" ? 15 : 5;
}

function sourceChanged(previous: ProductionContext | null, next: ProductionContext | null) {
  return previous?.directory.root !== next?.directory.root ||
    previous?.subtitle?.path !== next?.subtitle?.path ||
    previous?.subtitle?.sha256 !== next?.subtitle?.sha256;
}

export default function App() {
  const [screen, setScreen] = useState<"prepare" | "edit">("prepare");
  const [example, setExample] = useState(false);
  const [started, setStarted] = useState(false);
  const [preparationKey, setPreparationKey] = useState(0);
  const [production, setProduction] = useState<ProductionContext | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [trialAspect, setTrialAspect] = useState<Aspect | null>(null);
  const [delivery, setDelivery] = useState<{
    path?: string; webm?: string; broll?: string; error?: string; brollError?: string;
    retry?: string; camNote?: string; sfxSheet?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const jsonRequest = useRef<object | null>(null);
  const [jsonDelivery, setJsonDelivery] = useState<{ text: string; error?: boolean } | null>(null);
  const [draftProject, setDraftProject] = useState<DraftProject | null>(null);
  const documentLoadRequest = useRef(0);
  const subtitleRequest = useRef(0);
  const manualStarter = useRef<OverlayDoc | null>(null);
  const mediaRequest = useRef(0);
  const [committedDraft, setCommittedDraft] = useState<OverlayDoc | null>(null);
  const deliveredSubtitles = useRef<SrtLine[] | null>(null);
  // 明牌双模式:编辑台(视频+时间轴,像剪映)/ 效果库(挑卡调样式)
  const [tab, setTab] = useState<StudioTab>("edit");
  const [selectedId, setSelectedId] = useState(EFFECTS[0].id);
  // 每个动效各自保存一份参数,切换不丢
  const [paramsById, setParamsById] = useState<Record<string, any>>(() =>
    Object.fromEntries(EFFECTS.map((e) => [e.id, { ...e.defaults }])),
  );
  const [playToken, setPlayToken] = useState(0);
  const [showGuides, setShowGuides] = useState(true);
  const [showPerson, setShowPerson] = useState(true);
  // 导入的本地视频(object URL):编辑台=停在首帧等播放;效果库=静音循环当背景
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [restoredVideoUrl, setRestoredVideoUrl] = useState<string>();
  const uploadedVideo = useRef<File | null>(null);
  // 视频落盘期间锁住导入按钮。以前这里没有任何状态:传一条几百 MB 的口播要几十秒,
  // 界面全程毫无反应(画面里的视频还先被清掉了),换谁都会再点一次 —— 而同一个素材
  // 传第二遍正好是把后台搞死的那个操作。别的三个上传入口早就有这个锁,只有它漏了。
  const [videoBusy, setVideoBusy] = useState(false);
  // 本地服务在不在。页面是加载进浏览器内存的,服务停了它照样显示、按钮照样能点,
  // 只有真去请求后台才露馅 —— 用户完全没办法自己看出来。所以定时探一下,明着说。
  const [online, setOnline] = useState(true);
  const [videoDur, setVideoDur] = useState(0);
  // 编辑台的视频声音(效果库永远静音)
  const [muted, setMuted] = useState(false);
  // 视频画面缩放:视频自带黑边/比例不满时,放大充满画布(1 = 原始)
  const [videoScale, setVideoScale] = useState(1);
  // 动画速度倍率:加速/放慢所有卡片动画(导出同步生效)
  const [animSpeed, setAnimSpeed] = useState(1);
  // 特效整体缩放(1 = 100%)
  const [fxScale, setFxScale] = useState(1);
  // 导出透明动效层
  const [exporting, setExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportChoice, setExportChoice] = useState<{ aspect: Aspect; preset: ExportPreset }>();
  const [defaultDirectory, setDefaultDirectory] = useState("项目内 exports/output");
  const [exportDirectory, setExportDirectory] = useState<OutputDirectory & { remembered?: boolean }>();
  const [directoryError, setDirectoryError] = useState("");
  const [directoryUnavailable, setDirectoryUnavailable] = useState(false);
  const exportHost = (window as unknown as { chrome?: { webview?: DesktopHost } }).chrome?.webview;
  const subtitleOutput = production?.subtitleOutput;
  const activeExportDirectory = subtitleOutput && (!exportDirectory || exportDirectory.remembered)
    ? subtitleOutput : exportDirectory;
  useEffect(() => {
    if (!exportHost) return;
    const onDirectory = (event: Event) => {
      const data = (event as MessageEvent).data;
      if (data?.type !== "export-directory") return;
      if (data.status === "selected" && typeof data.destinationId === "string" && typeof data.path === "string") {
        setExportDirectory({ destinationId: data.destinationId, path: data.path, remembered: data.remembered });
        setDirectoryError("");
        setDirectoryUnavailable(false);
      } else if (data.status === "error") {
        setDirectoryError(typeof data.error === "string" ? data.error : "目录选择失败，请重新选择。");
        if (data.unavailable === true) setDirectoryUnavailable(true);
      }
    };
    exportHost.addEventListener("message", onDirectory);
    exportHost.postMessage({ type: "export-directory-ready" });
    return () => exportHost.removeEventListener("message", onDirectory);
  }, [exportHost]);
  const setEntryProduction = (context: ProductionContext | null) => {
    if (context?.subtitleOutput?.destinationId !== subtitleOutput?.destinationId) {
      setExportDirectory((directory) => directory?.remembered ? directory : undefined);
      setDirectoryError("");
      setDirectoryUnavailable(false);
    }
    setProduction(context);
  };
  // 导出进度(每秒轮询 /api/export-status)
  const [exportProg, setExportProg] = useState<{
    stage: string;
    frame: number;
    total: number;
    startedAt: number;
    framesAt: number;
  } | null>(null);

  // ---- 编辑台:时间轴 ----
  const [overlay, setOverlay] = useState<OverlayDoc | null>(null);
  // 画布跟随编排的 aspect(Kai fork · P1 双画布):STAGE 是原地改值的单例对象,
  // 光改它不会触发重渲染,所以改完用 tick 强制刷一帧,让 Canvas/卡片按新尺寸重读。
  // 所有载入路径(导入/示例/自动恢复/切换画布)都只改 overlay,这一个 effect 统一兜住。
  const [, setStageTick] = useState(0);
  useEffect(() => {
    setStage(trialAspect ?? (overlay ? aspectOfDoc(overlay) : "9:16"));
    setStageTick((t) => t + 1);
  }, [overlay?.aspect, !!overlay, trialAspect]);
  const [curT, setCurT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loopCardId, setLoopCardId] = useState<string | null>(null);
  const [seekVersion, setSeekVersion] = useState(0);
  const [selCardId, setSelCardId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // ---- 学习闭环:记住本次导入的「AI 初选」,导出时连同终选一起落盘 ----
  const originRef = useRef<OverlayDoc | null>(null);
  const transactionRef = useRef<{ key: string; before: Snap; draft: OverlayDoc | null } | null>(null);
  const wheelTimer = useRef<number | undefined>(undefined);
  const layoutRef = useRef(new Map<string, CardLayout>());
  const [layoutScale, setLayoutScale] = useState<number | undefined>();
  const [moveGroup, setMoveGroup] = useState(false);
  const [, setHistoryRevision] = useState(0);

  // ---- 检查器:导入 JSON 时自动跑,只提醒不阻断;忽略标记写进卡片随 JSON 持久化 ----
  const [lintIssues, setLintIssues] = useState<LintIssue[]>([]);
  const [lintCollapsed, setLintCollapsed] = useState(false);

  // ---- 字幕稿(SRT):点句跳转 / 标记覆盖情况 ----
  const [srt, setSrt] = useState<SrtLine[] | null>(null);

  // 「学一下」是这套工具里唯一一个用户发现不了的能力 —— 不主动说,它就等于不存在。
  // 每次导出都会落一份 review-log(初选 vs 终选),但用户不说那三个字就没人去读。
  // 第 1 次和第 3 次导出各提醒一次:第 1 次让他知道有这回事,第 3 次他已经攒够改动了。
  const LEARN_TIP_KEY = "overlayStudioLearnTipCount";
  const maybeShowLearnTip = () => {
    let n = 1;
    try {
      n = Number(localStorage.getItem(LEARN_TIP_KEY) || 0) + 1;
      localStorage.setItem(LEARN_TIP_KEY, String(n));
    } catch {
      return; // 隐私模式等禁用 localStorage:不提醒总比每次都弹强
    }
    if (n !== 1 && n !== 3) return;
    setTimeout(() => {
      alert(
        "💡 刚才这份「AI 排的 vs 你改完的」已经存下来了。\n\n" +
          "对 AI 助手说一句「学一下」,它会对比两版、把你改了两次以上的地方问你确认,\n" +
          "写进 skill 目录的《我的偏好.md》和《经验规则.md》。下一期就按你的排法生成。\n\n" +
          "跑几期之后,那份偏好表里的取值就全是你自己的了 —— \n" +
          "出厂的《我的偏好.default.md》是中性的,风格得你自己长出来。",
      );
    }, 400); // 让下载/导出的动作先走完,别打断
  };

  // ---- 外壳外观:两根正交的轴,都挂在 <html> 上 ----
  //   风格 data-form    = 形状骨架(App.css「风格骨架」一节)
  //   配色 data-palette = 颜色取值表(index.css)
  // 只换编辑台外壳,画布/卡片/导出画面完全不受影响。
  const FORM_KEY = "overlayStudioForm";
  const PALETTE_KEY = "overlayStudioPalette";
  const LEGACY_SKIN_KEY = "overlayStudioSkin"; // 单轴时代的旧键,读到就迁移
  // 老用户开机时把旧皮肤 id 拆成两轴;拆完删除旧键,只会跑这一次
  const restoreLook = () => {
    try {
      const legacy = localStorage.getItem(LEGACY_SKIN_KEY);
      if (legacy !== null) {
        const hit = LEGACY_SKIN_MAP[legacy] ?? { form: "", palette: "" };
        localStorage.setItem(FORM_KEY, hit.form);
        localStorage.setItem(PALETTE_KEY, hit.palette);
        localStorage.removeItem(LEGACY_SKIN_KEY);
        return hit;
      }
      const form = localStorage.getItem(FORM_KEY) ?? "";
      const palette = localStorage.getItem(PALETTE_KEY) ?? "";
      // 存档里是已下架的取值就回落默认
      return {
        form: FORMS.some((f) => f.id === form) ? form : "",
        palette: PALETTES.some((c) => c.id === palette) ? palette : "",
      };
    } catch {
      return { form: "", palette: "" };
    }
  };
  const [look] = useState(restoreLook);
  const [form, setForm] = useState<string>(look.form);
  const [palette, setPalette] = useState<string>(look.palette);
  // 换风格 = 连它的「原配」配色一起换上。
  // 曾经在这里加过「你手动挑过配色就不换」的判断,结果是:只要挑过一次配色,
  // 自动匹配就再也不触发,功能等于不存在。换风格本来就是「整套换掉」的动作,
  // 想要别的配色,换完再点一下配色下拉就行。
  const pickForm = (id: string) => {
    setForm(id);
    setPalette(FORMS.find((f) => f.id === id)?.mate ?? "");
  };

  useEffect(() => {
    const el = document.documentElement;
    if (form) el.dataset.form = form;
    else delete el.dataset.form;
    if (palette) el.dataset.palette = palette;
    else delete el.dataset.palette;
    try {
      localStorage.setItem(FORM_KEY, form);
      localStorage.setItem(PALETTE_KEY, palette);
    } catch {
      // 隐私模式:外观只在本次会话生效
    }
  }, [form, palette]);

  // 心跳:每 10 秒探一次后台(切到别的标签页时不探,省得白费请求)。
  // 回到这个标签页立刻补探一次 —— 「昨天的页面被浏览器恢复了、服务其实没起」
  // 正是最常见的那一幕,这时候第一时间告诉他,别等他点了导入才失败。
  useEffect(() => {
    // 连着两次探不到才算掉线。一次就报会误伤:改 vite.config.ts 会让服务自己重启一下,
    // 导出跑满 CPU 时也可能慢一拍 —— 那几秒里弹一条「服务已停止」比不弹更让人慌。
    let miss = 0;
    const ping = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/export-status", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const status = await r.json();
        if (typeof status.defaultDirectory === "string") setDefaultDirectory(status.defaultDirectory);
        miss = 0;
        setOnline(true);
      } catch {
        miss += 1;
        if (miss >= 2) setOnline(false);
      }
    };
    ping();
    const id = window.setInterval(ping, 10000);
    document.addEventListener("visibilitychange", ping);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", ping);
    };
  }, []);

  const committedOverlay = transactionRef.current ? transactionRef.current.before.overlay : overlay;
  const draftOrigin = originRef.current;
  const savedVideoUrl = videoUrl?.startsWith("/_media/") ? videoUrl : restoredVideoUrl;
  const pristineManual = committedOverlay === manualStarter.current && !srt?.length && !savedVideoUrl;
  const draftSnapshot = useMemo(() => draftProject && committedOverlay && !example ? {
    project: draftProject,
    overlay: committedOverlay,
    origin: draftOrigin,
    srt,
    videoUrl: savedVideoUrl,
  } : null, [draftProject, committedOverlay, draftOrigin, srt, savedVideoUrl, example]);
  const draft = useLocalDraft(draftSnapshot, pristineManual);
  const hasEditableDraft = ({ overlay: doc, srt: lines, draftProject: project, manualStarter: starter }:
    Pick<Snap, "overlay" | "srt" | "draftProject" | "manualStarter">) =>
    !!doc && (doc.cards.length > 0 || !!lines?.length || (!!project && doc !== starter && doc !== committedDraft));
  const hasCurrentDraft = hasEditableDraft({ overlay, srt, draftProject, manualStarter: manualStarter.current });

  const invalidateDocument = () => {
    documentLoadRequest.current++;
    subtitleRequest.current++;
    mediaRequest.current++;
    setRestoredVideoUrl(undefined);
    setVideoBusy(false);
    if (jsonRequest.current) {
      jsonRequest.current = null;
      setSaving(false);
    }
    setJsonDelivery(null);
    draft.cancel();
  };

  const restoreDraft = () => {
    if (hasCurrentDraft && !confirm("恢复草稿会替换当前编排，继续吗？")) return;
    try {
      const { raw, saved } = readDraft();
      if (!saved) throw new Error("没有可恢复的草稿。");
      const result = saved.overlay ? parseOverlay(saved.overlay) : null;
      if (result?.error) throw new Error(result.error);
      const doc = result?.doc ?? { version: 1 as const, aspect: "9:16" as const, cards: [] };
      const lines = Array.isArray(saved.srt) && saved.srt.length ? saved.srt : null;
      const url = typeof saved.videoUrl === "string" && saved.videoUrl.startsWith("/_media/")
        ? saved.videoUrl : undefined;
      resetSource();
      openDocument(doc, result?.dropped, result?.warnings, saved.project);
      originRef.current = saved.origin ?? null;
      setSrt(lines);
      setRestoredVideoUrl(url);
      if (url) {
        const request = mediaRequest.current;
        void fetch(url, { method: "HEAD" }).then((response) => {
          if (response.ok && request === mediaRequest.current) {
            setVideoUrl(url);
            setRestoredVideoUrl(undefined);
          }
        }).catch(() => {});
      }
      draft.resume({ project: saved.project, overlay: doc, origin: originRef.current, srt: lines, videoUrl: url }, saved, raw);
      setEntryProduction(null);
      setApplied(null);
    } catch (error) { alert(String(error)); }
  };

  // 落盘过的预览视频自动当全局「口播视频」:运镜卡导出时要烤的,和预览里那条
  // 本来就是同一条。放在 effect 里而不是导入回调里,是因为「先导视频后导编排」
  // 和「先导编排后导视频」两种顺序都要覆盖到。已经手填过的不动。
  // 用户点过「清除」就不再往回填。以前的判断只看 `!overlay.cam`,清除把 cam 置空 →
  // 条件重新成立 → 立刻又填回去,那个「清除」按钮等于一个摆设。
  // 记的是「用户主动清过」这件事本身,不是「哪条视频挂过」:后者在刷新(存档里 cam 已带值,
  // 记号没机会写)和换编排(视频没变、记号还在,新编排永远挂不上)两种情况下都会失效。
  // 换视频 / 导入新编排 / 载入示例时把记号清掉:那是一次新的开始,该挂还得挂。
  const camClearedRef = useRef(false);
  useEffect(() => {
    if (!overlay || overlay.cam || !videoUrl?.startsWith("/_media/")) return;
    if (camClearedRef.current) return;
    setOverlay((o) => (o && !o.cam ? { ...o, cam: videoUrl } : o));
  }, [overlay, videoUrl]);

  // ---- 撤销/重做(⌘Z / ⇧⌘Z):存 overlay + 字幕稿 快照 ----
  // 字幕稿也要进快照:「清空」会把它一起清掉,而弹窗承诺了能 ⌘Z 撤销 ——
  // 只记 overlay 的话,撤销回来卡片在、字幕稿没了,自动存档还会顺手把最后一份也覆盖掉。
  type Snap = {
    overlay: OverlayDoc | null;
    srt: SrtLine[] | null;
    production: ProductionContext | null;
    applied: string | null;
    origin: OverlayDoc | null;
    example: boolean;
    draftProject: DraftProject | null;
    manualStarter: OverlayDoc | null;
  };
  const snap = { overlay, srt, production, applied, origin: originRef.current, example, draftProject,
    manualStarter: manualStarter.current };
  const snapRef = useRef<Snap>(snap);
  snapRef.current = snap;
  const undoRef = useRef<Snap[]>([]);
  const redoRef = useRef<Snap[]>([]);
  const recordHistory = (before: Snap) => {
    undoRef.current.push(structuredClone(before));
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = [];
    setHistoryRevision((revision) => revision + 1);
  };

  const finishEdit = (commit: boolean) => {
    window.clearTimeout(wheelTimer.current);
    const transaction = transactionRef.current;
    if (!transaction) return;
    transactionRef.current = null;
    const { before, draft } = transaction;
    if (commit && draft !== before.overlay && JSON.stringify(draft) !== JSON.stringify(before.overlay)) {
      recordHistory(before);
    } else {
      snapRef.current = { ...snapRef.current, overlay: before.overlay };
      setOverlay(before.overlay);
    }
  };

  const beginEdit = (key: string) => {
    if (transactionRef.current?.key === key) return;
    finishEdit(true);
    const before = snapRef.current;
    transactionRef.current = { key, before, draft: before.overlay };
    if (key.startsWith("field:")) setPlaying(false);
  };

  const editOverlay = (update: (doc: OverlayDoc) => OverlayDoc) => {
    const transaction = transactionRef.current;
    const before = transaction ? transaction.draft : snapRef.current.overlay;
    if (!before) return;
    const next = update(before);
    if (next === before) return;
    if (transaction) transaction.draft = next;
    else recordHistory(snapRef.current);
    snapRef.current = { ...snapRef.current, overlay: next };
    setOverlay(next);
  };

  const pushHistory = (_force?: boolean) => {
    finishEdit(true);
    recordHistory(snapRef.current);
  };

  const applySnap = (s: Snap) => {
    if (snapRef.current.draftProject?.id !== s.draftProject?.id || snapRef.current.example !== s.example) {
      invalidateDocument();
      setLoopCardId(null);
    }
    if (sourceChanged(snapRef.current.production, s.production)) resetSource();
    setDraftProject(s.draftProject);
    manualStarter.current = s.manualStarter;
    setOverlay(s.overlay);
    setSrt(s.srt);
    setProduction(s.production);
    setApplied(s.applied);
    setExample(s.example);
    setTrialAspect(null);
    originRef.current = s.origin;
  };
  const undo = () => {
    finishEdit(true);
    if (!undoRef.current.length) return;
    redoRef.current.push(structuredClone(snapRef.current));
    applySnap(undoRef.current.pop()!);
    setHistoryRevision((revision) => revision + 1);
  };
  const redo = () => {
    finishEdit(true);
    if (!redoRef.current.length) return;
    undoRef.current.push(structuredClone(snapRef.current));
    applySnap(redoRef.current.pop()!);
    setHistoryRevision((revision) => revision + 1);
  };

  // 编辑台总时长 = max(视频时长, 最后一张卡结束)
  const duration = useMemo(() => {
    const cardsEnd = overlay ? Math.max(...overlay.cards.map((c) => c.end), 0) : 0;
    return Math.max(cardsEnd, videoDur);
  }, [overlay, videoDur]);

  // 编排体检:密度(张/分钟)+ 同屏峰值,顶栏一眼看节奏够不够紧
  const overlayStats = useMemo(() => {
    if (!overlay || overlay.cards.length === 0) return null;
    const evs = overlay.cards
      .flatMap((c) => [[c.start, 1], [c.end, -1]] as [number, number][])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0;
    let peak = 0;
    for (const [, d] of evs) {
      cur += d;
      if (cur > peak) peak = cur;
    }
    const span = Math.max(...overlay.cards.map((c) => c.end));
    return { peak, perMin: overlay.cards.length / Math.max(span / 60, 0.1) };
  }, [overlay]);

  const seek = (t: number, syncPausedVideo = false) => {
    curTRef.current = t;
    setCurT(t);
    setSeekVersion((version) => version + 1);
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration) &&
      (syncPausedVideo || !video.paused || (tabRef.current === "edit" && playingRef.current))) {
      video.currentTime = Math.min(t, video.duration);
    }
  };

  // 最新播放状态存 ref,给全局快捷键读(避免每帧重挂监听)
  const playingRef = useRef(false);
  playingRef.current = playing;
  const curTRef = useRef(0);
  const selCardIdRef = useRef<string | null>(null);
  selCardIdRef.current = selCardId;
  const deleteRef = useRef<(id: string) => void>(() => {});
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const durRef = useRef(0);
  durRef.current = duration;

  // 编辑快捷键在导出弹窗和文本输入中让位。
  // 空格 = 编辑台播放/暂停,效果库重放动画;← → = 快退/快进 0.5s,按住 Shift = 3s
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (screen === "prepare" || exportOpen) return;
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      const typing =
        el.isContentEditable ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (tag === "INPUT" &&
          ["text", "number", "search"].includes((el as HTMLInputElement).type));
      if (e.key === "Escape" && transactionRef.current) {
        e.preventDefault();
        finishEdit(false);
        return;
      }
      if (typing) return;

      if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") {
        // ⌘Z 撤销 / ⇧⌘Z 重做(时间轴改动)
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (
        (e.code === "Backspace" || e.code === "Delete") &&
        tabRef.current === "edit" &&
        selCardIdRef.current
      ) {
        // Delete = 删除选中的卡
        e.preventDefault();
        deleteRef.current(selCardIdRef.current);
      } else if (e.code === "Space") {
        e.preventDefault();
        if (tabRef.current === "edit") {
          if (durRef.current > 0) setPlaying((p) => !p);
        } else {
          setPlayToken((t) => t + 1);
        }
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        if (tag === "INPUT" && (el as HTMLInputElement).type === "range") return;
        // 两个模式都可用:效果库里用它挪 ➕ 的插入位置
        e.preventDefault();
        const step = (e.shiftKey ? 3 : 0.5) * (e.code === "ArrowLeft" ? -1 : 1);
        const nt = Math.min(Math.max(0, curTRef.current + step), durRef.current);
        seek(nt);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, exportOpen]);

  const handleImportJson = async (
    file: File | null,
    context?: ProductionContext | null,
    sourceVideo?: File | null,
    lines?: SrtLine[] | null,
  ) => {
    if (!file) return;
    const request = ++documentLoadRequest.current;
    const text = await file.text().catch((error) => {
      if (request === documentLoadRequest.current) alert(`❌ JSON 读取失败：${error}`);
      return null;
    });
    if (text === null || request !== documentLoadRequest.current) return;
    const { doc, error, dropped, warnings } = parseOverlay(text);
    if (error || !doc) {
      alert(`❌ JSON 导入失败:${error}`);
      return;
    }
    // 和「载入示例」一样先问一句。这个入口以前不问:拖错一个 JSON 进窗口,当前编排立刻被换掉,
    // 800ms 后自动存档也跟着被盖 —— ⌘Z 能救,刷新一次就救不回了。
    const current = snapRef.current;
    if (hasEditableDraft(current) && !confirm("导入这份编排会替换当前编排(可撤销),继续吗?")) return;
    if (context !== undefined) {
      if (sourceChanged(current.production, context)) resetSource();
      setEntryProduction(context);
      setApplied(null);
      setSrt(lines ?? null);
    }
    openDocument(doc, dropped, warnings, newDraftProject(context === undefined ? current.production : context, file.name));
    if (sourceVideo) void handleVideo(sourceVideo, false);
  };

  const enterEditor = () => {
    setStarted(true);
    setScreen("edit");
  };

  const newDraftProject = (context: ProductionContext | null, filename?: string): DraftProject => ({
    id: crypto.randomUUID?.() ?? crypto.getRandomValues(new Uint32Array(4)).join("-"),
    name: context?.subtitle?.name || context?.directory.name || filename || "手动编排",
  });

  const openDocument = (doc: OverlayDoc, dropped?: { kind: string; n: number }[], warnings?: string[],
    project: DraftProject | null = null, isManual = false) => {
    pushHistory(true);
    invalidateDocument();
    setDraftProject(project);
    setLoopCardId(null);
    setExample(false);
    setTrialAspect(null);
    setVideoScale(1);
    setCommittedDraft(doc);
    deliveredSubtitles.current = null;
    manualStarter.current = isManual ? doc : null;
    enterEditor();
    camClearedRef.current = false; // 新编排:口播视频该挂还得挂
    setOverlay(doc);
    originRef.current = structuredClone(doc); // AI 初选快照,学习闭环用
    setSelCardId(doc.cards[0]?.id ?? null);
    setTab("edit");
    seek(0);
    setPlaying(false);
    // 自动体检:只提醒不阻断导入。
    // 认不出的卡已经被跳过了,在这儿补一条 error —— 跳过必须看得见,
    // 否则用户只会觉得「导进来好像少了点东西」却说不上少了什么。
    setLintIssues([
      ...(warnings ?? []).map((message) => ({ level: "warn" as const, rule: "refinement", message })),
      ...(dropped ?? []).map((d) => ({
        level: "error" as const,
        rule: "unknown-kind",
        message: `跳过了 ${d.n} 张「${d.kind}」——  认不出这种卡,其余卡已正常导入。注意:再导出 JSON 时这几张不会带回去,原文件留好`,
      })),
      ...lintOverlay(doc, LINT_CFG, { duration: durRef.current || undefined }),
    ]);
    setLintCollapsed(false);
  };

  /** 检查面板「忽略」:有卡的问题把规则写进那张卡(用户主动决定,随 JSON 保存);
   *  没卡的问题(如 quiet-gap)只从本次列表移除 */
  const handleLintIgnore = (issue: LintIssue) => {
    if (!issue.cardId || !overlay) {
      setLintIssues((arr) => arr.filter((x) => x !== issue));
      return;
    }
    const next: OverlayDoc = {
      ...overlay,
      cards: overlay.cards.map((c) => {
        if (c.id !== issue.cardId || c.lintOff === true) return c;
        const off = Array.from(
          new Set([...(Array.isArray(c.lintOff) ? c.lintOff : []), issue.rule]),
        );
        return { ...c, lintOff: off };
      }),
    };
    pushHistory(true);
    setOverlay(next);
    setLintIssues(lintOverlay(next, LINT_CFG, { duration: durRef.current || undefined }));
  };

  /** 检查面板「定位」:有卡选中那张卡并跳到进场时刻;只有时间点(空白段)就直接跳时间 */
  const handleLintLocate = (issue: LintIssue) => {
    const c = issue.cardId ? overlay?.cards.find((x) => x.id === issue.cardId) : undefined;
    if (!c && issue.at == null) return;
    setTab("edit");
    if (c) {
      locateCard(c);
    } else {
      seek(issue.at! + 0.01);
    }
  };

  /** 载入内置演示编排(public/demo/):示例 SRT + 示例 JSON,不需要自己的视频 */
  const handleLoadDemo = async () => {
    if (hasCurrentDraft && !confirm("载入示例会替换当前编排(可撤销),继续吗?")) return;
    const request = ++documentLoadRequest.current;
    try {
      const [jsonText, srtText] = await Promise.all([
        fetch("/demo/demo-overlay.json").then((r) => r.text()),
        fetch("/demo/demo.srt").then((r) => r.text()),
      ]);
      if (request !== documentLoadRequest.current) return;
      const { doc, error, dropped, warnings } = parseOverlay(jsonText);
      if (error || !doc) {
        alert(`❌ 示例载入失败:${error}`);
        return;
      }
      // 内置示例理论上不该有认不出的卡。
      // 留这行 warn 当信号,别让示例悄悄少几张卡还没人发现。
      if (dropped?.length)
        console.warn("[示例] 跳过了认不出的卡:", dropped.map((d) => `${d.kind}×${d.n}`).join(", "));
      if (!draft.flush()) {
        enterEditor();
        return;
      }
      resetSource();
      setProduction(null);
      setApplied(null);
      openDocument(doc, undefined, warnings);
      setExample(true);
      const lines = parseSrt(srtText);
      setSrt(lines.length ? lines : null);
    } catch (e) {
      if (request === documentLoadRequest.current) alert(`❌ 示例载入失败:${e}`);
    }
  };

  const handleImportSrt = async (file: File | null) => {
    if (!file) return;
    const request = ++subtitleRequest.current;
    const text = await file.text().catch((error) => {
      if (request === subtitleRequest.current) alert(`❌ SRT 读取失败：${error}`);
      return null;
    });
    if (text === null || request !== subtitleRequest.current) return;
    const lines = parseSrt(text);
    if (!lines.length) {
      alert("❌ SRT 解析失败:没读到任何字幕条。");
      return;
    }
    pushHistory(true);
    const current = snapRef.current;
    const subtitleOverlay = current.overlay ?? { version: 1 as const, aspect: "9:16" as const, cards: [] };
    if (!current.example) {
      if (!current.draftProject) setDraftProject(newDraftProject(current.production, file.name));
      else if (!current.production) setDraftProject({ ...current.draftProject, name: file.name });
    }
    setSrt(lines);
    // 已有编排且还没有字幕层卡:自动生成一张常驻双语字幕卡(中文先就位,
    // 英文和 *关键词* 由生成器或你在右栏字幕表里补)
    if (current.overlay && !subtitleOverlay.cards.some((c) => c.kind === "caption-track")) {
      const def = EFFECTS.find((e) => e.id === "caption-track");
      const end = Math.ceil(Math.max(...lines.map((l) => l.end)));
      const linesText = lines
        .map(
          (l) =>
            `${l.start.toFixed(2)}|${l.end.toFixed(2)}|${l.text
              .replace(/\|/g, "/")
              .replace(/\s+/g, " ")
              .trim()}`,
        )
        .join("\n");
      setOverlay(withOverlayCards(subtitleOverlay, [
        ...subtitleOverlay.cards,
        {
          id: `caption-track-${subtitleOverlay.cards.length + 1}`,
          kind: "caption-track",
          start: 0,
          end,
          params: { ...(def?.defaults ?? {}), lines: linesText },
        },
      ]));
    } else if (!current.overlay) setOverlay(subtitleOverlay);
    setTab("edit");
  };

  const handleExportJson = async () => {
    if (!overlay || saving || jsonRequest.current) return false;
    finishEdit(true);
    const { overlay: doc, srt: subtitles } = snapRef.current;
    if (!doc) return false;
    const isCurrent = () => {
      const current = transactionRef.current?.before ?? snapRef.current;
      return current.overlay === doc && current.srt === subtitles;
    };
    if (production) {
      const request = {};
      jsonRequest.current = request;
      setSaving(true);
      setJsonDelivery({ text: "正在交付编排 JSON…" });
      try {
        const result = subtitleOutput
          ? await subtitleOutputRequest<{ path: string }>("save", subtitleOutput.destinationId, { doc })
          : await productionRequest<{ path: string }>("save-json", {
            root: production.directory.root, subtitle: production.subtitle?.relative, doc,
          });
        if (jsonRequest.current !== request) return false;
        if (!isCurrent()) {
          setJsonDelivery(null);
          return false;
        }
        setJsonDelivery({ text: `编排 JSON 已交付：${result.path}` });
      } catch (error) {
        if (jsonRequest.current === request) {
          setJsonDelivery(isCurrent() ? { text: `编排 JSON 交付失败：${error}`, error: true } : null);
        }
        return false;
      } finally {
        if (jsonRequest.current === request) {
          jsonRequest.current = null;
          setSaving(false);
        }
      }
    } else {
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "overlay.json";
      link.click();
      URL.revokeObjectURL(link.href);
      setJsonDelivery({ text: "已发起编排 JSON 下载" });
    }
    setCommittedDraft(doc);
    deliveredSubtitles.current = subtitles;
    // 学习闭环:AI 初选 + 用户终选 一起落盘(失败不打扰导出)
    fetch("/api/review-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        savedAt: new Date().toISOString(),
        origin: originRef.current,
        final: doc,
      }),
    }).catch(() => {});
    if (!production) maybeShowLearnTip();
    return true;
  };

  const handleClearOverlay = () => {
    // 「清空」清的是这一条编排:卡片 + 字幕稿 + 自动存档。以前只清卡片,字幕稿原样留着,
    // 下一条片子的卡就长在上一条的字幕上 —— 这也是「清除不干净」的一份。
    // 导入的视频不在此列,它有自己的「清除」按钮,不该被这里顺手带走。
    if (!confirm("清空这条编排?\n\n卡片和字幕稿都会清掉(导入的视频不受影响)。\n可以用 ⌘Z 撤销。"))
      return;
    if (draftProject && !example && !draft.discard(draftProject.id)) {
      alert("无法清除本机草稿，请重试。");
      return;
    }
    pushHistory(true);
    invalidateDocument();
    setDraftProject(null);
    setLoopCardId(null);
    setOverlay((doc) => doc ? withOverlayCards(doc, []) : null);
    setTrialAspect(null);
    setSrt(null);
    setPlaying(false);
    setSelCardId(null);
    seek(0);
  };


  const selCard = overlay?.cards.find((c) => c.id === selCardId) ?? null;
  // 「第几层」只在和它同时出现的卡里数 —— 全局第几张对观众没意义,同屏谁压谁才有
  const layerInfo = (() => {
    if (!overlay || !selCard) return undefined;
    const co = paintCards(overlay).filter(
      (c) => c.start < selCard.end && c.end > selCard.start,
    );
    return { index: co.findIndex((c) => c.id === selCard.id) + 1, total: co.length };
  })();

  // 编辑选中卡片的参数(编辑台)
  // 改选中卡的参数:必须用函数式 setOverlay。
  // 以前是 setOverlay({...overlay, …}),连着调 N 次会 N 次都从同一份旧
  // overlay 出发 —— 只有最后一个 key 生效。
  const updateCardParams = (id: string, patch: Record<string, unknown>) => {
    editOverlay((doc) => {
      const card = doc.cards.find((item) => item.id === id);
      if (!card || Object.entries(patch).every(([key, value]) => Object.is(card.params[key], value))) return doc;
      return { ...doc, cards: doc.cards.map((item) => item === card ? { ...item, params: { ...item.params, ...patch } } : item) };
    });
  };
  const handleCardParamChange = (key: string, value: unknown) => {
    if (!selCard) return;
    if (selectedPlacement?.mode === "auto" && Object.hasOwn(placementParams(selCard.kind, { [key]: value }), key)) {
      editOverlay((doc) => {
        const card = doc.cards.find(({ id }) => id === selCard.id);
        const current = card && frameOf(doc, card, shownAspect)?.current;
        if (!card || current?.mode !== "auto" || Object.is(current.placement?.[key as keyof typeof current.placement], value)) return doc;
        const placement = placementParams(card.kind, { ...current.placement, [key]: value });
        return writePlacement(doc, originRef.current, card, shownAspect, getLayout(card.id), { ...current, placement });
      });
    } else {
      updateCardParams(selCard.id, { [key]: value });
    }
  };

  // 更换选中卡片的特效类型(时间/落位保留,参数回到新卡默认值)
  const handleCardKindChange = (kind: string) => {
    if (!selCard || selCard.kind === kind) return;
    const effect = EFFECTS.find((item) => item.id === kind);
    if (!effect) return;
    finishEdit(true);
    editOverlay((doc) => withOverlayCards(doc, doc.cards.map((card) => card.id === selCard.id ? {
      ...card, kind, params: { ...effect.defaults, ...placementParams(kind, card.params) },
    } : card)));
  };

  const getLayout = (id: string) => layoutRef.current.get(id);
  const receiveLayout = (layouts: Map<string, CardLayout>) => {
    layoutRef.current = layouts;
    if (!playing) setLayoutScale(selCardId ? layouts.get(selCardId)?.scale : undefined);
  };

  const setCardPlacement = (
    id: string, layout: CardLayout, change: { dx: number; dy: number } | { scale: number; ax: number; ay: number },
    wholeGroup = false, wheelOffset = { x: 0, y: 0 },
  ) => {
    const aspect = trialAspect ?? aspectOfDoc(snapRef.current.overlay);
    editOverlay((doc) => {
      const card = doc.cards.find((item) => item.id === id);
      if (!card) return doc;
      const startCard = transactionRef.current?.before.overlay?.cards.find((item) => item.id === id) ?? card;
      const initialDoc = transactionRef.current?.before.overlay ?? doc;
      const initial = frameOf(initialDoc, startCard, aspect)?.current;
      const group = layout.group;
      const box = wholeGroup && group ? group.box : layout.box;
      const target = "dx" in change ? { ...box, ...moveBox(box, change.dx, change.dy, aspect), scale: layout.scale }
        : resizeBox(layout, change.scale, change.ax, change.ay, aspect);
      const dx = target.x - box.x, dy = target.y - box.y;
      if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001 && Math.abs(target.scale - layout.scale) < 0.00001) {
        // 回到手势起点时丢掉临时精修覆盖。
        return transactionRef.current?.key.startsWith("wheel") ? doc : initialDoc;
      }
      if (wholeGroup && group) {
        const saved = own(doc.refinement?.groups, group.name);
        return {
          ...doc,
          refinement: {
            schema: 1, ...doc.refinement,
            groups: {
              ...doc.refinement?.groups,
              [group.name]: {
                order: group.order,
                frames: { ...saved?.frames, [aspect]: { ...group.frame, x: group.frame.x + dx, y: group.frame.y + dy } },
              },
            },
          },
        };
      }
      const current: CardPlacement = group
        ? { mode: "group", group: group.name, x: dx / group.frame.fit + wheelOffset.x + (initial?.mode === "group" ? initial.x : 0),
            y: dy / group.frame.fit + wheelOffset.y + (initial?.mode === "group" ? initial.y : 0), scale: target.scale / group.frame.fit }
        : { mode: "free", x: target.x, y: target.y, scale: target.scale };
      return writePlacement(doc, originRef.current, card, aspect, layout, current);
    });
  };

  const scaleCard = (id: string, value: number, layout?: CardLayout) => {
    const start = layout ?? getLayout(id);
    if (start) setCardPlacement(id, start, { scale: value, ax: 0.5, ay: 0.5 });
  };

  const wheelCard = (id: string, delta: number) => {
    const layout = getLayout(id);
    if (!layout || !delta) return;
    selectCard(id);
    beginEdit(`wheel:${id}`);
    const aspect = trialAspect ?? aspectOfDoc(snapRef.current.overlay);
    const doc = snapRef.current.overlay;
    const card = doc?.cards.find((item) => item.id === id);
    const current = doc && card ? frameOf(doc, card, aspect)?.current : undefined;
    const initialDoc = transactionRef.current?.before.overlay;
    const initial = initialDoc && card ? frameOf(initialDoc, card, aspect)?.current : undefined;
    const relative = current?.mode === "group" && initial?.mode === "group" ? { x: current.x - initial.x, y: current.y - initial.y }
      : current?.mode === "group" ? current : { x: 0, y: 0 };
    // Each wheel event extends the result of the previous event in this burst.
    setCardPlacement(id, layout, { scale: (Math.round(layout.scale / SCALE_STEP) - Math.sign(delta)) * SCALE_STEP, ax: 0.5, ay: 0.5 }, false, relative);
    window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => finishEdit(true), 220);
  };

  const resetCardPlacement = (id: string) => {
    finishEdit(true);
    const aspect = trialAspect ?? aspectOfDoc(snapRef.current.overlay);
    editOverlay((doc) => {
      const card = doc.cards.find((item) => item.id === id);
      if (!card) return doc;
      const saved = frameOf(doc, card, aspect);
      const origin = originRef.current?.cards.find((item) => item.id === id);
      const base = saved?.base ?? {
        mode: "auto" as const, placement: placementParams(card.kind, origin?.params ?? card.params),
        ...(card.seg && { group: card.seg }),
      };
      if (JSON.stringify(saved?.current) === JSON.stringify(base)) return doc;
      if (!saved?.current && base.mode === "auto" && (base.group ?? card.seg) === card.seg &&
          JSON.stringify(placementParams(card.kind, card.params)) ===
          JSON.stringify(placementParams(card.kind, base.placement ?? {}))) return doc;
      return writePlacement(doc, originRef.current, card, aspect, getLayout(id), base);
    });
    setMoveGroup(false);
  };

  const detachCard = (id: string) => {
    finishEdit(true);
    const layout = getLayout(id);
    if (!layout?.group) return;
    const aspect = trialAspect ?? aspectOfDoc(snapRef.current.overlay);
    editOverlay((doc) => {
      const card = doc.cards.find((item) => item.id === id);
      if (!card) return doc;
      return writePlacement(doc, originRef.current, card, aspect, layout,
        { mode: "free", x: layout.box.x, y: layout.box.y, scale: layout.scale });
    });
    setMoveGroup(false);
  };

  // 画布比例(Kai fork · P1):写进编排文件(16:9 时存 undefined,旧文件字节不变),
  // 画布尺寸由上面的 effect 统一跟随;可 ⌘Z 撤销。注意:切换只换画布,卡片落位
  // 仍是横屏逻辑——竖屏三带落位是 P2 的事,别指望切完卡片自动排好。
  const handleAspect = (aspect: Aspect) => {
    finishEdit(true);
    setPlaying(false);
    setTrialAspect(aspect === (overlay ? aspectOfDoc(overlay) : "9:16") ? null : aspect);
  };

  const confirmAspect = () => {
    if (!trialAspect) return;
    pushHistory(true);
    setOverlay((doc) => ({ ...(doc ?? { version: 1, cards: [] }), aspect: trialAspect }));
    setTrialAspect(null);
  };

  // 全局底色:一键统一所有卡片的亮/暗(覆盖每张卡的单独设置,可 ⌘Z 撤销)
  const handleGlobalTheme = (theme: "dark" | "light") => {
    if (!overlay) return;
    pushHistory(true);
    setOverlay({
      ...overlay,
      theme,
      cards: overlay.cards.map((c) => ({ ...c, params: { ...c.params, theme } })),
    });
  };

  // 删除卡片(时间轴选中后 Delete / 右栏按钮)
  const handleDeleteCard = (id: string) => {
    pushHistory(true);
    setOverlay((o) =>
      o ? withOverlayCards(o, o.cards.filter((c) => c.id !== id)) : o,
    );
    setSelCardId((cur) => (cur === id ? null : cur));
    setLoopCardId((current) => current === id ? null : current);
  };
  deleteRef.current = handleDeleteCard; // 给全局快捷键(Delete)用

  // 时间轴色块拖拽:直接写回某张卡的起止时间
  const handleCardTimes = (id: string, start: number, end: number) => {
    editOverlay((doc) => {
      const card = doc.cards.find((item) => item.id === id);
      if (!card || !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
          (card.start === start && card.end === end)) return doc;
      const original = transactionRef.current?.before.overlay;
      const originalCard = original?.cards.find((item) => item.id === id);
      if (original && originalCard?.start === start && originalCard.end === end) return original;
      return { ...preserveGroupOrder(doc, card), cards: doc.cards.map((item) => item === card ? { ...item, start, end } : item) };
    });
  };

  /**
   * 叠放顺序从底到顶单独保存，时间轴和组内顺排使用各自的顺序。
   * 只在"和它时间上有重叠"的卡之间挪 —— 跟不同时出现的卡换先后没有任何视觉意义,
   * 白白把数组搅乱。挪不动(上面/下面没有重叠的卡了)就原样返回。
   */
  const handleCardLayer = (dir: "up" | "down" | "top" | "bottom") => {
    if (!overlay || !selCardId) return;
    const cards = paintCards(overlay).slice();
    const i = cards.findIndex((c) => c.id === selCardId);
    if (i < 0) return;
    const me = cards[i];
    const hit = (c: OverlayCard) => c.id !== me.id && c.start < me.end && c.end > me.start;
    let j = -1;
    if (dir === "up") for (let k = i + 1; k < cards.length; k++) { if (hit(cards[k])) { j = k; break; } }
    if (dir === "top") for (let k = cards.length - 1; k > i; k--) { if (hit(cards[k])) { j = k; break; } }
    if (dir === "down") for (let k = i - 1; k >= 0; k--) { if (hit(cards[k])) { j = k; break; } }
    if (dir === "bottom") for (let k = 0; k < i; k++) { if (hit(cards[k])) { j = k; break; } }
    if (j < 0) return;
    pushHistory();
    cards.splice(i, 1);
    // 往上挪:插到目标后面(删除自己后目标退了一格,插在 j 正好就是它后面)
    // 往下挪:插到目标前面(目标索引比自己小,删除不影响它,插在 j 就是它前面)
    cards.splice(j, 0, me);
    setOverlay({ ...overlay, refinement: { schema: 1, ...overlay.refinement, paintOrder: cards.map(({ id }) => id) } });
  };

  // 编辑选中卡片的出现/消失时间(秒)
  const handleCardTimeChange = (key: "start" | "end", value: number) => {
    if (!selCard) return;
    handleCardTimes(selCard.id, key === "start" ? value : selCard.start, key === "end" ? value : selCard.end);
  };

  // 画布直接拖拽/滚轮:给卡片参数打补丁(不触发重放)
  const handleNudge = (cardId: string | null, patch: Record<string, number>) => {
    if (cardId) {
      updateCardParams(cardId, patch);
    } else {
      setParamsById((prev) => ({
        ...prev,
        [selectedId]: { ...prev[selectedId], ...patch },
      }));
    }
  };

  // 效果库 → 时间轴:把当前效果(带调好的参数)插到当前时刻
  const handleAddToTimeline = () => {
    if (!draftProject && !example) setDraftProject(newDraftProject(production));
    const start = Math.round(curTRef.current * 10) / 10;
    const baseCards = overlay?.cards ?? [];
    let n = baseCards.length + 1;
    while (baseCards.some((c) => c.id === `card-${n}`)) n++;
    const card: OverlayCard = {
      id: `card-${n}`,
      kind: selectedId,
      start,
      // 整段演示类的卡默认给足 15 秒,其他卡 5 秒
      end: start + addSecFor(selectedId),
      params: { ...paramsById[selectedId] },
    };
    pushHistory(true);
    setOverlay((o) => {
      const doc: OverlayDoc = o ? withOverlayCards(o, [...o.cards, card].sort((a, b) => a.start - b.start))
        : { version: 1 as const, aspect: "9:16" as const, theme: paramsById[selectedId]?.theme, cards: [card] };
      return {
        ...doc,
        refinement: {
          schema: 1, ...doc.refinement,
          byCard: {
            ...doc.refinement?.byCard,
            [card.id]: { frames: {
              "9:16": { base: { mode: "auto", placement: placementParams(card.kind, card.params) } },
              "16:9": { base: { mode: "auto", placement: placementParams(card.kind, card.params) } },
            } },
          },
        },
      };
    });
    setSelCardId(card.id);
    // 以前这里 setTab("edit") 把人甩回编辑台:点一下整个界面就变了,是最容易
    // 让人失去方向的一种反馈,想连着加三张卡也得来回切。时间轴两个模式都常驻,
    // 新卡在轨道上直接看得见,不用换页确认。
  };

  const exportAspect = aspectOfDoc(overlay);
  const exportPresets: ExportPreset[] = [
    { resolution: "1080p", fps: 24 }, { resolution: "1080p", fps: 30 },
    { resolution: "720p", fps: 24 }, { resolution: "720p", fps: 30 },
  ];
  if (exportAspect === "16:9") exportPresets.push({ resolution: "1080p", fps: "30000/1001" });
  const preset = exportChoice?.aspect === exportAspect
    ? exportChoice.preset
    : { resolution: "1080p", fps: exportAspect === "16:9" ? "30000/1001" : 30 } as const;
  const exportSize = resolveExport({ doc: overlay, preset, duration: duration || undefined });
  const sampleFrame = Math.min(exportSize.frames - 1, frameAtOrBefore(curT, exportSize.rate));
  const sampleTime = frameTime(sampleFrame, exportSize.rate);
  const activeCards = useMemo(() => overlay?.cards.filter((card) => isVisibleAt(sampleTime, card)) ?? [], [overlay, sampleTime]);
  const selectedFrames = selCard && duration > 0 ? visibleFrameRange(selCard, exportSize.rate, exportSize.frames) : null;

  const loopCard = loopCardId ? overlay?.cards.find((card) => card.id === loopCardId) : null;
  const loopFrames = loopCard && visibleFrameRange(loopCard, exportSize.rate, exportSize.frames);
  const loopStart = loopFrames ? frameTime(loopFrames.first, exportSize.rate) : undefined;
  const loopEnd = loopFrames && loopCard
    ? Math.min(loopCard.end, frameTime(loopFrames.endExclusive, exportSize.rate), duration)
    : undefined;

  useLayoutEffect(() => {
    if (loopCardId && !loopFrames) setLoopCardId(null);
  }, [loopCardId, !!loopFrames]);

  // 口播有效时跟随视频时钟，编排超出口播尾部时接续本地时钟。
  useLayoutEffect(() => {
    if (tab !== "edit" || !playing) return;
    const video = videoRef.current;
    let active = true;
    let followingVideo = false;
    let raf = 0;
    let last = performance.now();
    const looping = loopStart !== undefined && loopEnd !== undefined;

    const insideVideo = () => !!video && (!Number.isFinite(video.duration) || curTRef.current < video.duration);
    const syncVideo = () => {
      if (!video) return;
      const shouldFollow = insideVideo();
      if (shouldFollow === followingVideo) return;
      followingVideo = shouldFollow;
      if (shouldFollow) video.play().catch(() => { if (active) setPlaying(false); });
      else video.pause();
    };

    if (looping && (curTRef.current < loopStart || curTRef.current >= loopEnd)) seek(loopStart, true);
    if (!looping && video?.ended && curTRef.current >= duration) seek(0, true);
    syncVideo();
    const tick = (now: number) => {
      // 首个动画帧的时间戳可能早于刚切换时钟时读取的 performance.now()。
      const elapsed = Math.max(0, now - last) / 1000;
      const next = Math.min(duration, video && insideVideo() && !video.ended
        ? video.currentTime
        : Math.max(curTRef.current, video?.currentTime ?? 0) + elapsed);
      last = now;
      if (looping && (next < loopStart || next >= loopEnd)) {
        if (video?.paused) followingVideo = false;
        seek(loopStart, true);
      } else {
        curTRef.current = next;
        setCurT(next);
        if (!looping && next >= duration) {
          setPlaying(false);
          return;
        }
      }
      syncVideo();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(raf);
      video?.pause();
    };
  }, [tab, playing, duration, videoUrl, loopStart, loopEnd]);

  const keepDisplayedPosition = () => {
    // 保留点击时已显示的位置，避免同一轮尚未提交的播放时钟更新改变它。
    curTRef.current = curT;
    setCurT(curT);
  };

  const toggleLoop = () => {
    if (loopCardId) {
      if (playing) {
        if (curTRef.current < curT) seek(curT, true);
        else keepDisplayedPosition();
      }
      setLoopCardId(null);
      return;
    }
    if (!selCard || !selectedFrames) return;
    finishEdit(true);
    setLoopCardId(selCard.id);
    setTab("edit");
    seek(frameTime(selectedFrames.first, exportSize.rate), true);
    setPlaying(true);
  };

  const pauseAtCurrentPosition = () => {
    if (playing) keepDisplayedPosition();
    setPlaying(false);
  };

  const changeTab = (next: StudioTab) => {
    if (next === tab) return;
    finishEdit(true);
    pauseAtCurrentPosition();
    setTab(next);
  };

  const selectCard = (id: string | null) => {
    if (id !== selCardIdRef.current) {
      finishEdit(true);
      setMoveGroup(false);
      setLayoutScale(id ? layoutRef.current.get(id)?.scale : undefined);
    }
    setTab("edit");
    pauseAtCurrentPosition();
    setSelCardId(id);
  };

  const locateCard = (card: OverlayCard) => {
    const frames = visibleFrameRange(card, exportSize.rate, exportSize.frames);
    selectCard(card.id);
    if (frames) seek(frameTime(frames.first, exportSize.rate));
  };

  const stepFrame = (delta: -1 | 1) => {
    const current = Math.min(exportSize.frames - 1, frameAtOrBefore(curTRef.current, exportSize.rate));
    const target = Math.max(0, Math.min(exportSize.frames - 1, current + delta));
    setPlaying(false);
    setTab("edit");
    seek(frameTime(target, exportSize.rate));
  };

  const openExport = () => {
    if (exporting || trialAspect) return;
    if (!overlay || overlay.cards.length === 0) {
      alert("时间轴上还没有卡片:先 📥 导入 JSON,或去 ✨ 效果库 ➕ 加入卡片。");
      return;
    }
    setExportOpen(true);
  };

  const handleExport = async () => {
    if (exporting || trialAspect || directoryUnavailable || !overlay?.cards.length) return;
    setExportOpen(false);
    setExporting(true);
    // 完成时发系统通知(切去别的应用也能收到);先申请权限
    if (!production && "Notification" in window && Notification.permission === "default")
      Notification.requestPermission().catch(() => {});
    // 每秒轮询导出进度,驱动右下角进度浮窗
    const poll = window.setInterval(async () => {
      try {
        const r = await fetch("/api/export-status");
        const p = await r.json();
        if (p.running) setExportProg(p);
      } catch {
        /* 服务器重启等瞬时失败,忽略 */
      }
    }, 1000);
    // 学习闭环:定稿导出时也落一份「初选 vs 终选」日志
    fetch("/api/review-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        savedAt: new Date().toISOString(),
        origin: originRef.current,
        final: overlay,
      }),
    }).catch(() => {});
    if (!production) maybeShowLearnTip();
    setDelivery(null);
    try {
      // 导出整条 overlay(时长 = 最后一张卡结束 + 0.5s 尾巴)
      // 尾巴是留给末尾音效收干净的,别用 ceil 取整 —— 28.0s 的片子会被抬到 29s,
      // 白白多出整整一秒空帧(卡片走到 end 就卸掉了,尾巴里什么都没有)。
      const body = {
        doc: overlay,
        scale: fxScale,
        speed: animSpeed,
        preset,
        destinationId: activeExportDirectory?.destinationId,
        duration: Math.max(...overlay.cards.map((c) => c.end)) + 0.5,
        delivery: production && !subtitleOutput ? { root: production.directory.root, subtitle: production.subtitle?.relative } : undefined,
      };
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // 线上试玩版没有导出后端(逐帧渲染要本地无头 Chrome + ffmpeg):给友好提示,不甩报错。
      // 判断依据只能是「返回的不是 JSON」—— 静态托管会回 HTML(404 或 SPA 回退)。
      // 不能用 !res.ok:本地导出失败时服务端返回的是 500 + JSON,里面带着真正的
      // 失败原因,当成"线上版"会把这条信息直接丢掉,用户和你都不知道到底为什么失败。
      if (!(res.headers.get("content-type") ?? "").includes("json")) {
        alert(
          "🌐 当前是线上试玩版,不支持导出。\n\n导出透明 MOV 需要在本地运行:\n  git clone 仓库 → npm install → npm run dev\n\n完整步骤见 README「快速开始」。",
        );
        return;
      }
      const data = await res.json();
      if (data.lastDestination) {
        exportHost?.postMessage({
          type: "remember-export-directory",
          destinationId: data.lastDestination.destinationId,
        });
      }
      if (data.ok) {
        if ("Notification" in window && Notification.permission === "granted")
          new Notification("✅ 动效层导出完成", {
            body: "透明 MOV 和 WebM 已就绪",
          });
      } else if (activeExportDirectory && /目录.*(失效|不可写)/.test(String(data.error))) {
        setDirectoryError("所选目录已失效或不可写，请重新选择或使用默认目录。");
        setDirectoryUnavailable(true);
      }
      const raw = String(data.error ?? "导出失败，请检查所选目录和导出环境。");
      const reason = raw.lastIndexOf("【导出失败原因】");
      setDelivery({
        path: data.mov, webm: data.webm, broll: data.delivered, brollError: data.deliveryError,
        retry: data.retry, camNote: data.camNote, sfxSheet: data.sfxSheet,
        error: data.ok ? undefined : raw.slice(Math.max(0, reason)),
      });
    } catch (e) {
      alert(`❌ 导出失败:${e}`);
    } finally {
      window.clearInterval(poll);
      setExporting(false);
      setExportProg(null);
    }
  };

  const retryDelivery = async () => {
    if (!delivery?.retry || saving) return;
    setSaving(true);
    try {
      const result = await productionRequest<{ path: string }>("retry-mov", { retry: delivery.retry });
      setDelivery({ ...delivery, broll: result.path, brollError: undefined, retry: undefined });
    } catch (error) {
      setDelivery({ ...delivery, brollError: String(error) });
    } finally { setSaving(false); }
  };

  const handleVideo = async (file: File | null, replacePrevious = true) => {
    if (videoBusy && replacePrevious) return;
    if (file && file === uploadedVideo.current) return;
    setVideoScale(1);
    uploadedVideo.current = null;
    setVideoDur(0);
    camClearedRef.current = false; // 换了视频,之前那次「清除」不作数
    // 记住换之前的主视频:下面落盘成功后,如果全局「口播视频」(overlay.cam)就是它,要跟着换。
    // 以前不换 —— 自动挂载只在 cam 为空时生效,换视频后 cam 还指着上一条:预览里运镜卡
    // 圆窗放的是新视频(预览用 videoUrl),导出烤进去的却是旧的(导出用 doc.cam),而且没有任何提示。
    // 只在「cam 等于旧主视频」时换:用户在侧栏手动选过别的口播视频,那是他的选择,不动。
    const request = ++mediaRequest.current;
    setRestoredVideoUrl(undefined);
    const prevUrl = videoUrl;
    setVideoUrl((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return null;
    });
    if (!file) {
      setPlaying(false);
      return;
    }
    setPlaying(false);
    setVideoBusy(true);
    // 先落盘换一个真实路径:刷新后能自动恢复,无头 Chrome 导出时也读得到。
    // 线上试玩版没有这个后端,退回 blob 地址 —— 那种情况下刷新仍需重新导入。
    try {
      const r = await fetch("/api/media", {
        method: "POST",
        headers: { "x-filename": encodeURIComponent(file.name) },
        body: file,
      });
      // 非 2xx 也要把响应体读出来:后台写盘失败时会认真回一句原因(500 + JSON),
      // 以前 `r.ok ? … : null` 直接把它扔了,页面一声不吭退回 blob,用户以为导入成功了
      const d = await r.json().catch(() => null);
      if (request !== mediaRequest.current) return;
      if (d?.ok && d.url) {
        uploadedVideo.current = file;
        setVideoUrl(d.url);
        if (replacePrevious) setOverlay((o) => (o && o.cam && o.cam === prevUrl ? { ...o, cam: d.url } : o));
        return;
      }
      alert(
        `❌ 视频落盘失败:${d?.error ?? `HTTP ${r.status}`}\n\n` +
          "先用临时地址预览;这种情况下刷新要重新导入,导出时也带不上口播。",
      );
    } catch (e) {
      if (request !== mediaRequest.current) return;
      // 本地服务没在跑的时候会走到这儿。以前这里一声不吭地退回 blob,用户不知道后台已经
      // 掉线,只会觉得「刷新一次素材就没了」。和其他三个上传入口一样弹一句人话;
      // 顶部横幅交给心跳去判(它要连续两次探不到才报,这里一次失败就翻旗会闪一下又消失)。
      alert(`❌ 视频落盘失败:${uploadErrText(e)}`);
    } finally {
      if (request === mediaRequest.current) setVideoBusy(false);
    }
    if (request === mediaRequest.current) setVideoUrl(URL.createObjectURL(file));
  };

  // 效果库当前效果。selectedId 一直来自 EFFECTS,理论上找得到,
  // 但别再用 ! 假装 —— 真找不到就退回第一张,不要往下传 undefined。
  const effect = useMemo(
    () => EFFECTS.find((e) => e.id === selectedId) ?? EFFECTS[0],
    [selectedId],
  );
  const params = paramsById[selectedId];

  const handleParamChange = (key: string, value: unknown) => {
    setParamsById((prev) => ({
      ...prev,
      [selectedId]: { ...prev[selectedId], [key]: value },
    }));
    setPlayToken((t) => t + 1); // 改参数即重放,便于观察
  };

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setPlayToken((t) => t + 1);
  };

  const resetSource = () => {
    uploadedVideo.current = null;
    if (videoUrl?.startsWith("blob:")) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setVideoDur(0);
    setSrt(null);
    setDelivery(null);
  };

  const startManual = (context: ProductionContext | null, aspect: Aspect, video: File | null, lines: SrtLine[] | null) => {
    if (hasCurrentDraft && !confirm("开始手动编排会替换当前编排，继续吗？")) return;
    if (!video && !lines?.length && !draft.flush()) {
      enterEditor();
      return;
    }
    resetSource();
    setEntryProduction(context);
    setApplied(null);
    openDocument({ version: 1, aspect, cards: [] }, undefined, undefined, newDraftProject(context), true);
    setSrt(lines);
    if (video) void handleVideo(video, false);
  };

  const applyCandidate = (context: ProductionContext | null, doc: OverlayDoc, lines: SrtLine[] | null, identity: string, video: File | null, warnings?: string[]) => {
    if (hasCurrentDraft && !confirm("用这份候选替换当前编排？当前手调内容会被替换。")) return false;
    if (sourceChanged(production, context)) resetSource();
    setEntryProduction(context);
    openDocument(doc, undefined, warnings, newDraftProject(context));
    setSrt(lines);
    setApplied(identity);
    if (video) void handleVideo(video, false);
    return true;
  };

  const startOver = async () => {
    finishEdit(true);
    let discard = false;
    const hasUndeliveredSubtitles = overlay?.cards.length === 0 && !!srt?.length && srt !== deliveredSubtitles.current;
    if (!example && hasCurrentDraft && (overlay !== committedDraft || hasUndeliveredSubtitles)) {
      if (confirm("本次有未导出的手调稿。先导出编排 JSON？")) {
        if (!await handleExportJson()) return;
        if (production) return; // 保留导出路径提示，再点一次即可重新开始。
      } else {
        if (!confirm("确认放弃尚未导出的手调稿并重新开始？")) return;
        discard = true;
      }
    }
    if (discard && draftProject && !draft.discard(draftProject.id)) {
      alert("无法清除本机草稿，请重试。");
      return;
    }
    if (!discard && !draft.flush()) return;
    invalidateDocument();
    setDraftProject(null);
    setLoopCardId(null);
    resetSource();
    setOverlay(null);
    setSelCardId(null);
    setPlaying(false);
    setTrialAspect(null);
    setEntryProduction(null);
    setApplied(null);
    setStarted(false);
    setExample(false);
    setLintIssues([]);
    setCommittedDraft(null);
    deliveredSubtitles.current = null;
    manualStarter.current = null;
    undoRef.current = [];
    redoRef.current = [];
    originRef.current = null;
    seek(0);
    setPreparationKey((key) => key + 1);
    setScreen("prepare");
  };

  // 参数面板:编辑台改选中的卡,效果库改当前效果
  const inEdit = tab === "edit";
  const panelEffect =
    // 这里以前的 ! 是「整页白屏」的根因:编排里只要有一张不认识的卡,
    // 查出来就是 undefined。现在照实传下去,由 ParamsPanel 说清楚是哪张。
    inEdit && selCard ? EFFECTS.find((e) => e.id === selCard.kind) : effect;
  const shownAspect = trialAspect ?? aspectOfDoc(overlay);
  const selectedPlacement = overlay && selCard ? frameOf(overlay, selCard, shownAspect)?.current : undefined;
  const panelParams = inEdit && selCard ? { ...selCard.params, ...(selectedPlacement?.mode === "auto" && selectedPlacement.placement) } : params;
  const selectedGroup = selCard ? cardGroup(selCard, selectedPlacement) : undefined;
  const dragWholeGroup = moveGroup && !!selectedGroup;
  const sliderStart = useRef<CardLayout | undefined>(undefined);
  const beginSlider = () => {
    if (!selCard) return;
    sliderStart.current = getLayout(selCard.id);
    beginEdit(`scale:${selCard.id}`);
  };
  const finishSlider = (commit: boolean) => {
    sliderStart.current = undefined;
    finishEdit(commit);
  };
  const panelOnChange = inEdit && selCard ? handleCardParamChange : handleParamChange;

  return (
    <>
    <div hidden={screen !== "prepare"}>
      <Preparation key={preparationKey} desktopHost={exportHost} hasEditor={started} savedDraft={draft.saved} applied={applied}
        onResume={enterEditor} onManual={startManual} onApply={applyCandidate} onImport={handleImportJson}
        onDemo={handleLoadDemo} onRestore={restoreDraft} />
    </div>
    <div
      className="app production-editor" hidden={screen !== "edit"}
      /* 拖文件进窗口即导入:视频 → 垫底预览,JSON → 时间轴 */
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (!f) {
          alert("❌ 没有读到文件——请从「访达」把文件本体拖进来(从应用里直接拖可能拖不出文件)。");
          return;
        }
        if (f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(f.name)) {
          handleVideo(f);
        } else if (f.type === "application/json" || /\.json$/i.test(f.name)) {
          handleImportJson(f);
        } else if (/\.srt$/i.test(f.name)) {
          handleImportSrt(f);
        } else {
          alert(`❌ 不认识的文件类型:${f.name}(支持视频 mp4/mov/webm、overlay JSON 和 SRT 字幕)`);
        }
      }}
    >
      {!online && (
        <div className="offline-bar">
          ⚠️ 本地服务已停止 —— 这个页面还开着,但导入、上传、导出都不会成功。
          回到启动时那个终端窗口,重新运行 <code>npm run dev</code>(或再双击一次启动器),然后刷新本页。
        </div>
      )}
      {((draftProject && draft.status) || jsonDelivery) && (
        <div className="editor-save-feedback">
          {draftProject && draft.status && (
            <div role={draft.status === "failed" || draft.status === "conflict" ? "alert" : "status"} data-draft-status={draft.status}>
              {draft.status === "saving" ? "正在保存本机草稿…" : draft.status === "failed" ? "本机草稿保存失败"
                : draft.status === "conflict" ? "其他窗口已更改本机草稿。可导出当前编排 JSON，或返回准备页恢复最新草稿。"
                : draft.saved?.savedAt ? `本机草稿已保存 · ${draftTime(draft.saved.savedAt)}` : "本机草稿已保存"}
              {draft.status === "failed" && <button onClick={draft.flush}>重试保存草稿</button>}
            </div>
          )}
          {jsonDelivery && <div role={jsonDelivery.error ? "alert" : "status"} data-json-delivery>{jsonDelivery.text}</div>}
        </div>
      )}
      <TopBar
        productionName={subtitleOutput ? production?.subtitle?.name : production?.directory.name}
        aspect={trialAspect ?? (overlay ? aspectOfDoc(overlay) : "9:16")}
        trial={!!trialAspect}
        onAspect={handleAspect}
        onConfirmAspect={confirmAspect}
        onCancelAspect={() => setTrialAspect(null)}
        onPreparation={() => { finishEdit(true); setPlaying(false); setScreen("prepare"); }}
        onUndo={undo}
        onRedo={redo}
        canUndo={undoRef.current.length > 0}
        canRedo={redoRef.current.length > 0}
        onStartOver={startOver}
        onExportJson={handleExportJson}
        saving={saving}
        tab={tab}
        onTab={changeTab}
        curT={curT}
        duration={duration}
        playing={playing}
        shown={activeCards.length}
        total={overlay?.cards.length ?? 0}
        stats={overlayStats}
        selCardId={inEdit ? selCardId : null}
        muted={muted}
        onToggleMute={() => setMuted((m) => !m)}
        onPlayPause={() => durRef.current > 0 && setPlaying((p) => !p)}
        onReset={() => {
          setPlaying(false);
          seek(0);
        }}
        onImportJson={handleImportJson}
        onLoadDemo={handleLoadDemo}
        effectName={effect.name}
        onReplay={() => setPlayToken((t) => t + 1)}
        exporting={exporting}
        hasVideo={videoUrl !== null}
        videoBusy={videoBusy}
        onVideo={handleVideo}
        onExport={openExport}
        exportPanel={{
          open: exportOpen,
          preset,
          presets: exportPresets,
          dimensions: `${exportSize.width} × ${exportSize.height}`,
          directory: activeExportDirectory?.path ?? defaultDirectory,
          directoryError,
          directoryUnavailable,
          onPreset: (choice) => setExportChoice({ aspect: exportAspect, preset: choice }),
          onDirectory: exportHost && (() => exportHost.postMessage({ type: "select-export-directory" })),
          onDefaultDirectory: exportHost && (activeExportDirectory !== subtitleOutput || directoryError ? () => {
            setExportDirectory(undefined);
            setDirectoryError("");
            setDirectoryUnavailable(false);
          } : undefined),
          onClose: () => setExportOpen(false),
          onSubmit: () => void handleExport(),
        }}
        form={form}
        onForm={pickForm}
        palette={palette}
        onPalette={setPalette}
        hasDoc={!!overlay}
        font={overlay?.font ?? ""}
        onFont={(f) => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, font: f || undefined } : o));
        }}
        glow={!!overlay?.glow}
        onToggleGlow={() => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, glow: !o.glow } : o));
        }}
        breath={!!overlay?.breath}
        onToggleBreath={() => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, breath: o.breath ? undefined : true } : o));
        }}
        inkColor={overlay?.inkColor ?? ""}
        onInkColor={(c) => {
          pushHistory(true);
          setOverlay((o) => (o ? { ...o, inkColor: c || undefined } : o));
        }}
        onUnifyAccent={(accent) => {
          // 批量改写:把每张卡的 accent 参数直接改掉(不是盖一层),
          // 改完各卡参数面板显示的就是新值,之后还能单张调回去。force 压一步撤销。
          pushHistory(true);
          setOverlay((o) =>
            o
              ? {
                  ...o,
                  cards: o.cards.map((c) =>
                    "accent" in (c.params ?? {})
                      ? { ...c, params: { ...c.params, accent } }
                      : c,
                  ),
                }
              : o,
          );
        }}
        showPerson={showPerson}
        onTogglePerson={() => setShowPerson((v) => !v)}
      />
      <div className="app-body">
      <Sidebar
        tab={tab}
        onTab={changeTab}
        effects={EFFECTS}
        selectedId={selectedId}
        onSelect={handleSelect}
        onReplay={() => setPlayToken((t) => t + 1)}
        hasVideo={videoUrl !== null}
        fxScale={fxScale}
        videoScale={videoScale}
        onVideoScale={setVideoScale}
        animSpeed={animSpeed}
        onAnimSpeed={setAnimSpeed}
        exporting={exporting}
        overlay={overlay}
        selCardId={selCardId}
        onGlobalTheme={handleGlobalTheme}
        cam={overlay?.cam ?? ""}
        onSetCam={(src) => {
          camClearedRef.current = !src; // 清空 = 用户主动清过,自动挂载别再填回来
          setOverlay((o) => (o ? { ...o, cam: src || undefined } : o));
        }}
        srt={srt}
        curT={curT}
        onSeek={seek}
        onImportSrt={handleImportSrt}
        onSelectCard={selectCard}
        onImportJson={handleImportJson}
        onExportJson={handleExportJson}
        onClearOverlay={handleClearOverlay}
        videoBusy={videoBusy}
        onVideo={handleVideo}
        onFxScale={setFxScale}
        onExport={openExport}
      />

      <main className="stage-col">
        <Canvas
          effect={effect}
          params={params}
          playToken={playToken}
          showGuides={showGuides}
          onToggleGuides={() => setShowGuides((v) => !v)}
          showPerson={showPerson}
          videoUrl={videoUrl}
          fxScale={fxScale}
          overlayCards={inEdit ? activeCards : null}
          overlayDoc={overlay}
          onLayout={receiveLayout}
          onBeginEdit={beginEdit}
          onFinishEdit={finishEdit}
          onPlaceCard={setCardPlacement}
          onWheelCard={wheelCard}
          moveGroup={dragWholeGroup}
          now={sampleTime}
          playing={playing}
          seekVersion={seekVersion}
          overlayTheme={overlay?.theme}
          overlayCam={overlay?.cam}
          glow={overlay?.glow ?? false}
          breath={overlay?.breath ?? false}
          font={overlay?.font}
          inkColor={overlay?.inkColor}
          videoMuted={muted}
          videoScale={videoScale}
          animSpeed={animSpeed}
          videoElRef={(el) => (videoRef.current = el)}
          onVideoMeta={(nextDuration) => {
            setVideoDur(nextDuration);
            if (inEdit) {
              const cardsEnd = Math.max(0, ...(overlay?.cards.map((card) => card.end) ?? []));
              seek(Math.min(curTRef.current, Math.max(cardsEnd, nextDuration)));
            }
          }}
          onNudge={handleNudge}
          onPickCard={selectCard}
          selectedCardId={selCardId}
        />
      </main>

      <ParamsPanel
        effect={panelEffect}
        params={panelParams}
        onChange={panelOnChange}
        card={inEdit ? selCard : null}
        editMode={inEdit}
        cardTime={sampleTime}
        canLocateCard={!!selectedFrames}
        onLocateCard={locateCard}
        onLayer={handleCardLayer}
        layer={layerInfo}
        onTimeChange={handleCardTimeChange}
        onKindChange={handleCardKindChange}
        onDelete={handleDeleteCard}
        onResetPlacement={inEdit && selCard ? () => resetCardPlacement(selCard.id) : undefined}
        onDetach={inEdit && selCard && selectedGroup && layoutScale !== undefined ? () => detachCard(selCard.id) : undefined}
        groupName={inEdit ? selectedGroup : undefined}
        moveGroup={dragWholeGroup}
        onToggleMoveGroup={() => setMoveGroup((value) => !value)}
        editScale={inEdit && selCard ? layoutScale : undefined}
        onBeginScale={beginSlider}
        onFinishScale={finishSlider}
        onEditScale={inEdit && selCard ? (value) => scaleCard(selCard.id, value, sliderStart.current) : undefined}
        onBeginEdit={beginEdit}
        onFinishEdit={finishEdit}
        onAddToTimeline={handleAddToTimeline}
        globalBreath={overlay?.breath === true}
        addAt={curT}
        addSec={addSecFor(selectedId)}
      />
      </div>

        <TimelineBar
          duration={duration}
          t={curT}
          sampleTime={sampleTime}
          cards={overlay?.cards ?? []}
          selectedId={selCardId}
          shown={activeCards.length}
          onSeek={seek}
          onSelect={selectCard}
          frameIndex={sampleFrame}
          lastFrame={duration > 0 ? exportSize.frames - 1 : 0}
          fpsLabel={preset.fps === "30000/1001" ? "29.97" : String(preset.fps)}
          onStepFrame={stepFrame}
          loopTarget={loopCard}
          loopUnavailable={selectedFrames ? undefined : selCard ? "该卡时段没有可播放的成品帧" : "请先选择一张卡片"}
          onToggleLoop={toggleLoop}
          onTimes={handleCardTimes}
          onBeginEdit={beginEdit}
          onFinishEdit={finishEdit}
        />

      {delivery && <div className="production-delivery" role={delivery.error || delivery.brollError ? "alert" : "status"}>
        <strong>{delivery.error ? "导出未完整完成" : delivery.brollError ? "成品已保存，B-roll 交付失败" : "已保存"}</strong>
        {delivery.error && <p>{delivery.error}</p>}
        {delivery.brollError && <p>{delivery.brollError}</p>}
        {delivery.path && <p>MOV：{delivery.path}</p>}
        {delivery.webm && <p>WebM：{delivery.webm}</p>}
        {delivery.broll && delivery.broll !== delivery.path && <p>B-roll：{delivery.broll}</p>}
        {delivery.sfxSheet && <p>音效清单：{delivery.sfxSheet}</p>}
        {delivery.camNote && <p>运镜片段合成说明：{delivery.camNote}</p>}
        {delivery.retry && <button onClick={retryDelivery} disabled={saving}>重试交付 MOV</button>}
        <button onClick={() => setDelivery(null)}>关闭</button>
      </div>}
      {/* 导出进度浮窗(右下角):渲染帧数 + 预计剩余 + 合成阶段 */}
      {exporting && <ExportProgress prog={exportProg} />}

      {/* 检查器浮窗(左下角):导入 JSON 自动体检的结果,只提醒不阻断 */}
      {lintIssues.length > 0 && (
        <LintPanel
          issues={lintIssues}
          collapsed={lintCollapsed}
          onToggle={() => setLintCollapsed((v) => !v)}
          onClose={() => setLintIssues([])}
          onLocate={handleLintLocate}
          onIgnore={handleLintIgnore}
        />
      )}
    </div>
    </>
  );
}

function LintPanel({
  issues,
  collapsed,
  onToggle,
  onClose,
  onLocate,
  onIgnore,
}: {
  issues: LintIssue[];
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  onLocate: (i: LintIssue) => void;
  onIgnore: (i: LintIssue) => void;
}) {
  const errors = issues.filter((i) => i.level === "error").length;
  return (
    <div className="lint-panel">
      <div className="lint-head" onClick={onToggle}>
        <span>
          🔍 体检:{errors > 0 && <b className="lint-err-count">{errors} 个必修</b>}
          {errors > 0 && issues.length > errors && " · "}
          {issues.length > errors && `${issues.length - errors} 个建议`}
        </span>
        <span className="lint-head-btns">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {collapsed ? "展开" : "收起"}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            ✕
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="lint-list">
          {issues.map((i, idx) => (
            <div key={idx} className={`lint-item lint-${i.level}`}>
              <span className="lint-msg">
                {i.level === "error" ? "❌" : "⚠️"} {i.message}
              </span>
              <span className="lint-btns">
                {(i.cardId || i.at != null) && <button onClick={() => onLocate(i)}>定位</button>}
                <button title={i.cardId ? "写进这张卡,以后不再提醒" : "本次不再显示"} onClick={() => onIgnore(i)}>
                  忽略
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExportProgress({
  prog,
}: {
  prog: { stage: string; frame: number; total: number; startedAt: number; framesAt: number } | null;
}) {
  let pct = 2;
  let text = "准备中(启动渲染器)…";
  if (prog) {
    if (prog.stage === "extract") {
      text = "预处理素材:把卡片里的视频抽成帧(长录屏要几分钟)…";
    } else if (prog.stage === "frames" && prog.total > 0) {
      // 渲染帧占进度的前 80%,后面是合成/混音
      pct = Math.max(2, Math.round((prog.frame / prog.total) * 80));
      // ⚠️ 只按「逐帧渲染开跑之后」的耗时算(framesAt,不是 startedAt)。
      // 用任务启动时刻的话,前面抽帧/启浏览器那几分钟会被摊进每帧耗时,
      // 第一次报数(第 30 帧)能报出几十分钟,然后一路往下掉 —— 纯属吓人。
      const elapsed = (Date.now() - (prog.framesAt || prog.startedAt)) / 1000;
      const eta =
        prog.frame > 0
          ? Math.round((elapsed / prog.frame) * (prog.total - prog.frame))
          : 0;
      const fmt =
        eta >= 60 ? `${Math.floor(eta / 60)} 分 ${eta % 60} 秒` : `${eta} 秒`;
      text = `渲染帧 ${prog.frame}/${prog.total} · 预计还需 ${fmt}`;
    } else if (prog.stage === "mov") {
      pct = 84;
      text = "合成透明 MOV(长视频这步要几分钟)…";
    } else if (prog.stage === "webm") {
      pct = 93;
      text = "合成 WebM 小体积版…";
    } else if (prog.stage === "sfx") {
      pct = 98;
      text = "把音效混进 MOV…";
    } else if (prog.stage === "publish") {
      pct = 99;
      text = "写入成品目录…";
    }
  }
  return (
    <div className="export-prog">
      <div className="export-prog-head">
        <span>🎞 导出中</span>
        <b>{pct}%</b>
      </div>
      <div className="export-prog-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="export-prog-sub">{text}</div>
    </div>
  );
}
