import { flushSync } from "react-dom";
import { inkVars } from "../effects/hud/accent";
import { BreathContext } from "../effects/breath";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { EffectDef } from "../effects/types";
import { EFFECTS } from "../effects/registry";
import { STAGE, VERTICAL_PERSON, VERTICAL_STAGE_VARS, VERTICAL_LAYOUT, verticalBand, getAspect } from "../stage";
import safePortrait from "../assets/safe-area-916.png";
import safeLandscape from "../assets/safe-area-169.png";
import { VerticalCardFit } from "./VerticalCardFit";
import { focusCamGeomAt } from "../effects/hud/camGeom";
import type { OverlayCard, OverlayDoc } from "../overlay/types";
import { frameOf, restorePlacementParams, type CardLayout } from "../overlay/placement";
import { OverlayLayout } from "./OverlayLayout";
import { editPointer } from "./editPointer";
import { cardFrame } from "../overlay/card-frame";
import { useEnter } from "../effects/useAnimation";
import { FxSpeedScope } from "../effects/FxSpeedScope";

/** 拖拽/滚轮时对卡片参数打补丁;cardId=null 表示单特效预览模式 */
export type NudgeFn = (cardId: string | null, patch: Record<string, number>) => void;

interface CanvasProps {
  effect: EffectDef<any>;
  params: any;
  playToken: number;
  showGuides: boolean;
  showPerson: boolean;
  onToggleGuides: () => void;
  videoUrl: string | null;
  fxScale: number;
  /** 时间轴模式:当前时间点应显示的卡片(null = 单特效预览模式) */
  overlayCards?: OverlayCard[] | null;
  overlayDoc?: OverlayDoc | null;
  onLayout?: (layouts: Map<string, CardLayout>) => void;
  onBeginEdit?: (key: string) => void;
  onFinishEdit?: (commit: boolean) => void;
  onPlaceCard?: (id: string, layout: CardLayout, change: { dx: number; dy: number } | { scale: number; ax: number; ay: number }, wholeGroup?: boolean) => void;
  onWheelCard?: (id: string, delta: number) => void;
  moveGroup?: boolean;
  /** 时间轴模式:当前播放头时刻(秒),注入给时间感知卡(章节条/字幕层) */
  now?: number;
  playing?: boolean;
  seekVersion: number;
  overlayTheme?: "dark" | "light";
  overlayCam?: string;
  /** 文字可读性光晕(默认关) */
  glow?: boolean;
  /** 呼吸感(doc.breath):卡片落定后微动,见 effects/breath.tsx */
  breath?: boolean;
  /** 全局字体(doc.font):空 = 默认 */
  font?: string;
  /** 全局文字色(doc.inkColor):盖住主题的 --hud-ink,次要文字同色降透明度 */
  inkColor?: string;
  /** 时间轴模式下是否静音(单特效模式恒静音,自动播放要求) */
  videoMuted?: boolean;
  /** 视频画面缩放:源视频带黑边时放大充满画布 */
  videoScale?: number;
  /** 动画速度倍率(1 = 原速) */
  animSpeed?: number;
  videoElRef?: (el: HTMLVideoElement | null) => void;
  /** 视频元数据加载后上报时长(编辑台时间轴用) */
  onVideoMeta?: (duration: number) => void;
  onNudge?: NudgeFn;
  onPickCard?: (id: string | null) => void;
  selectedCardId?: string | null;
}

/* 画布尺寸见 src/stage.ts */

/**
 * 卡片交互壳:display:contents 不产生盒子,不影响卡片自身定位;
 * 拖动 = 改 offsetX/offsetY,滚轮 = 改 scale(CSS 变量透过它继承下去)。
 */
/** 拖拽时的对齐吸附上下文:舞台元素 + 辅助线上报 */
interface SnapCtx {
  stageEl: () => HTMLDivElement | null;
  setGuides: (g: { v: number[]; h: number[] }) => void;
}

/** 吸附阈值(舞台像素) */
const SNAP_PX = 12;

function snapAxis(edges: number[], candidates: number[]) {
  let best: { d: number; adj: number; at: number } | undefined;
  for (const at of candidates) {
    for (const edge of edges) {
      const adj = at - edge;
      const d = Math.abs(adj);
      if (d < SNAP_PX && (!best || d < best.d)) best = { d, adj, at };
    }
  }
  return best;
}


function CardShell({
  cardId,
  params,
  stageScale,
  fxScale,
  animSpeed,
  frame,
  time,
  start,
  playing,
  seekVersion,
  onNudge,
  onPick,
  snapCtx,
  chapterDrag,
  onCardPointer,
  onCardWheel,
  children,
}: {
  cardId: string | null;
  params: any;
  stageScale: number;
  fxScale: number;
  animSpeed: number;
  frame?: ReturnType<typeof cardFrame>;
  time?: number;
  start?: number;
  playing?: boolean;
  seekVersion?: number;
  onNudge?: NudgeFn;
  onPick?: (id: string) => void;
  snapCtx?: SnapCtx;
  chapterDrag?: boolean;
  onCardPointer?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onCardWheel?: (delta: number) => void;
  children: ReactNode;
}) {
  const { w: STAGE_W, h: STAGE_H } = STAGE;
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);
  const scale = fxScale * (Number(params.scale) || 1);
  // 有效倍速 = 全局「动画速度」×该卡自己的「动画速度(此卡)」
  const speed = animSpeed * (Number(params.speed) || 1);
  return (
    <div
      style={{
        display: "contents",
        cursor: onNudge ? "grab" : undefined,
        ["--hud-scale" as string]: scale,
        ...frame?.style,
      }}
      /* 逐卡主题:这张卡自己选的亮/暗覆盖全局(未选则继承) */
      data-card-id={cardId ?? undefined}
      data-chapter-drag={chapterDrag ? "" : undefined}
      data-card-theme={(params.theme as string) || undefined}
      /* 讲过变浅:挂在这个 display:contents 的壳上,靠后代选择器落到卡根元素,
         所以每一张卡都能用,不必逐卡加参数 */
      data-past={frame?.past ? "1" : undefined}
      /* 退场淡出:同样靠后代选择器落到卡根元素,不必逐卡加参数 */
      data-outro={frame?.outro === undefined ? undefined : "1"}
      /* 讲过之后的让位方式:both 变浅+缩小(默认)/ fade 只变浅 / shrink 只缩小 */
      data-dim-mode={(params.dimMode as string) || undefined}
      onPointerDown={(e) => {
        if (onCardPointer) { onCardPointer(e); return; }
        if (!onNudge || e.button !== 0) return;
        if (cardId && onPick) onPick(cardId);
        e.preventDefault();
        // 卡内分件拖拽:卡片自己给某块标 data-drag-x/y = 该块的坐标参数名
        // (如手托展示的左右两块),拖它就只改那两个参数,不动整卡 offset。
        const partEl = (e.target as HTMLElement).closest<HTMLElement>("[data-drag-x]");
        endDrag.current?.();
        let manualPlacement = false;
        // 对齐吸附:拖动开始时量一次"被拖元素"(段头=整段容器)和其他元素的舞台坐标
        interface Box { l: number; t: number; r: number; b: number }
        let snap: { m0: Box; others: Box[] } | null = null;
        const stageEl = partEl ? null : snapCtx?.stageEl();
        if (stageEl) {
          const sr = stageEl.getBoundingClientRect();
          const k = sr.width / STAGE_W || 1;
          const toStage = (r: DOMRect): Box => ({
            l: (r.left - sr.left) / k,
            t: (r.top - sr.top) / k,
            r: (r.right - sr.left) / k,
            b: (r.bottom - sr.top) / k,
          });
          const contents = e.currentTarget as HTMLElement;
          const anchor = contents.querySelector<HTMLElement>(".hud-anchor, .ctrack-cue, .slot, .chapter-plate");
          const stack = anchor?.closest<HTMLElement>(".seg-stack") ?? null;
          const isHead = !!stack && stack.firstElementChild === contents;
          const moved = isHead ? stack : anchor;
          manualPlacement = !!moved && (chapterDrag || (!!moved.closest(".vertical-card-fit") && (!stack || isHead)));
          if (moved) {
            const others: Box[] = [];
            stageEl.querySelectorAll<HTMLElement>(".hud-anchor, .seg-stack, .chapter-plate").forEach((el) => {
              if (el === moved || moved.contains(el) || el.contains(moved)) return;
              others.push(toStage(el.getBoundingClientRect()));
            });
            snap = { m0: toStage(moved.getBoundingClientRect()), others };
          }
        }
        const band = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-band]")?.dataset.band;
        const keyX = partEl?.dataset.dragX || (manualPlacement ? "manualX" : "offsetX");
        const keyY = partEl?.dataset.dragY || (manualPlacement ? "manualY" : "offsetY");
        const start = { x: e.clientX, y: e.clientY, ox: Number(params[keyX]) || 0, oy: Number(params[keyY]) || 0 };
        const pointerId = e.pointerId;
        const move = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          let dx = (ev.clientX - start.x) / stageScale;
          let dy = (ev.clientY - start.y) / stageScale;
          const g = { v: [] as number[], h: [] as number[] };
          if (snap) {
            const { m0, others } = snap;
            const region = band && !manualPlacement ? VERTICAL_LAYOUT[band as keyof typeof VERTICAL_LAYOUT] : undefined;
            const vCands = [region?.left ?? (manualPlacement ? 0 : 120),
              region ? (region.left + region.right) / 2 : STAGE_W / 2,
              ...others.flatMap((o) => [o.l, (o.l + o.r) / 2, o.r])];
            const hCands = [region?.top ?? (manualPlacement ? 0 : 96),
              region ? (region.top + region.bottom) / 2 : STAGE_H / 2,
              ...others.flatMap((o) => [o.t, (o.t + o.b) / 2, o.b])];
            const bx = snapAxis([m0.l + dx, (m0.l + m0.r) / 2 + dx, m0.r + dx], vCands);
            if (bx) {
              dx += bx.adj;
              g.v.push(bx.at);
            }
            const by = snapAxis([m0.t + dy, (m0.t + m0.b) / 2 + dy, m0.b + dy], hCands);
            if (by) {
              dy += by.adj;
              g.h.push(by.at);
            }
          }
          if (manualPlacement && snap) {
            const { m0 } = snap;
            dx = Math.max(-m0.l, Math.min(STAGE_W - m0.r, dx));
            dy = Math.max(-m0.t, Math.min(STAGE_H - m0.b, dy));
          }
          snapCtx?.setGuides(g);
          onNudge(cardId, {
            [keyX]: Math.round(start.ox + dx),
            [keyY]: Math.round(start.oy + dy),
          });
        };
        const stop = (ev: PointerEvent) => {
          if (ev.pointerId === pointerId) cleanup();
        };
        const cleanup = () => {
          endDrag.current = null;
          snapCtx?.setGuides({ v: [], h: [] });
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", stop);
          window.removeEventListener("pointercancel", stop);
          window.removeEventListener("blur", cleanup);
        };
        endDrag.current = cleanup;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        window.addEventListener("blur", cleanup);
      }}
      onWheel={(e) => {
        if (onCardWheel) { e.stopPropagation(); onCardWheel(e.deltaY); return; }
        if (!onNudge) return;
        const cur = Number(params.scale) || 1;
        const next = Math.min(2, Math.max(0.4, cur - Math.sign(e.deltaY) * 0.05));
        onNudge(cardId, { scale: Number(next.toFixed(2)) });
      }}
    >
      <FxSpeedScope speed={speed} time={time} start={start} playing={playing} seekVersion={seekVersion}>{children}</FxSpeedScope>
    </div>
  );
}

export function Canvas({
  effect,
  params,
  playToken,
  showGuides,
  showPerson,
  onToggleGuides,
  videoUrl,
  fxScale,
  overlayCards,
  overlayDoc,
  onLayout,
  onBeginEdit,
  onFinishEdit,
  onPlaceCard,
  onWheelCard,
  moveGroup,
  now,
  playing,
  seekVersion,
  overlayTheme,
  overlayCam,
  glow,
  breath,
  font,
  inkColor,
  videoMuted,
  videoScale,
  animSpeed,
  videoElRef,
  onVideoMeta,
  onNudge,
  onPickCard,
  selectedCardId,
}: CanvasProps) {
  // 画布逻辑尺寸:1920×1080
  const { w: STAGE_W, h: STAGE_H } = STAGE;
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const gestures = useRef<((commit: boolean) => void) | null>(null);
  useEffect(() => () => gestures.current?.(false), []);
  const layouts = useRef(new Map<string, CardLayout>());
  const [selection, setSelection] = useState<CardLayout | undefined>();
  const updateLayout = (next: Map<string, CardLayout>) => {
    layouts.current = next;
    if (!playing) {
      const current = selectedCardId ? next.get(selectedCardId) : undefined;
      setSelection((previous) => JSON.stringify(previous) === JSON.stringify(current) ? previous : current);
    }
    onLayout?.(next);
  };
  const videoNodeRef = useRef<HTMLVideoElement | null>(null);
  const [scale, setScale] = useState(0.5);
  // 拖拽对齐辅助线(青色虚线,吸附时出现)
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const snapCtx: SnapCtx = { stageEl: () => stageRef.current, setGuides };
  // 运镜:播放后从满屏缩到左侧
  const camIn = useEnter(playToken);

  // 把 1920×1080 逻辑画布等比缩放塞进可用空间
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      setScale(Math.min(width / STAGE_W, height / STAGE_H));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [STAGE_W, STAGE_H]);

  const side = params.side ?? "left";
  const Effect = effect.Component;
  const overlayMode = overlayCards != null;

  // 模式切换时接管视频播放:效果库=静音循环背景;编辑台=停住等播放键
  useEffect(() => {
    const v = videoNodeRef.current;
    if (!v) return;
    if (!overlayMode) {
      v.muted = true;
      v.play().catch(() => {});
    } else if (!playing) {
      v.pause();
    }
  }, [overlayMode, videoUrl]);
  const alignPrimaryVideo = (video: HTMLVideoElement) => {
    if (!overlayMode || playing || now === undefined || !Number.isFinite(video.duration)) return;
    video.pause();
    const target = Math.min(now, video.duration);
    if (Math.abs(video.currentTime - target) > 0.0001) video.currentTime = target;
  };

  useLayoutEffect(() => {
    const video = videoNodeRef.current;
    if (video) alignPrimaryVideo(video);
  }, [overlayMode, playing, now, videoUrl]);

  const vertical = STAGE_H > STAGE_W;
  const person = VERTICAL_PERSON;
  const isHud = overlayMode || effect.selfPosition === true;
  const theme = overlayMode ? (overlayTheme ?? "dark") : (params.theme ?? "dark");

  // 满屏运镜卡激活时,口播画面缩进对应落位框:focus-card → 左侧圆角方框。
  // 落位靠 class,几何走 camGeom 里那一份,和卡片自己用的是同一个函数,预览和导出不会各画各的
  const PIP_KINDS: Record<string, (p: any) => string> = {
    "focus-card": (p) => (p?.side === "right" ? "is-pip-focus is-pip-focus-r" : "is-pip-focus"),
  };
  const pipCard = overlayMode
    ? overlayCards.find((c) => c.kind in PIP_KINDS)
    : effect.id in PIP_KINDS
      ? { kind: effect.id, params }
      : null;
  const beginPointer = (
    event: ReactPointerEvent<HTMLElement>, id: string, corner?: { x: number; y: number },
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    onPickCard?.(id);
    const initial = layouts.current.get(id);
    if (!initial || playing) return;
    const group = !corner && !!moveGroup && id === selectedCardId && !!initial.group;
    const movingBox = group ? initial.group!.box : initial.box;
    const others = [...layouts.current].filter(([otherId, layout]) =>
      otherId !== id && (!group || layout.group?.name !== initial.group?.name)).map(([, layout]) => layout.box);
    const horizontal = [0, STAGE_W / 2, STAGE_W, ...others.flatMap(({ x, w }) => [x, x + w / 2, x + w])];
    const vertical = [0, STAGE_H / 2, STAGE_H, ...others.flatMap(({ y, h }) => [y, y + h / 2, y + h])];
    const part = corner || group ? null : (event.target as HTMLElement).closest<HTMLElement>("[data-drag-x]");
    const card = overlayCards?.find((item) => item.id === id);
    const keyX = part?.dataset.dragX;
    const keyY = part?.dataset.dragY;
    const x = event.clientX, y = event.clientY;
    gestures.current?.(false);
    onBeginEdit?.(`canvas:${id}`);
    gestures.current = editPointer(event.pointerId, (pointer) => {
      const dx = (pointer.clientX - x) / scale;
      const dy = (pointer.clientY - y) / scale;
      if (corner) {
        const sx = corner.x ? -initial.box.w : initial.box.w;
        const sy = corner.y ? -initial.box.h : initial.box.h;
        const ratio = 1 + (dx * sx + dy * sy) / (sx * sx + sy * sy);
        onPlaceCard?.(id, initial, { scale: initial.scale * ratio, ax: corner.x, ay: corner.y });
      } else if (keyX && keyY && card) {
        onNudge?.(id, {
          [keyX]: (Number(card.params[keyX]) || 0) + Math.round(dx / initial.scale),
          [keyY]: (Number(card.params[keyY]) || 0) + Math.round(dy / initial.scale),
        });
      } else {
        const { x, y, w, h } = movingBox;
        const hSnap = pointer.altKey ? undefined : snapAxis([x + dx, x + dx + w / 2, x + dx + w], horizontal);
        const vSnap = pointer.altKey ? undefined : snapAxis([y + dy, y + dy + h / 2, y + dy + h], vertical);
        setGuides({ v: hSnap ? [hSnap.at] : [], h: vSnap ? [vSnap.at] : [] });
        onPlaceCard?.(id, initial, { dx: dx + (hSnap?.adj ?? 0), dy: dy + (vSnap?.adj ?? 0) }, group);
      }
    }, (commit) => {
      gestures.current = null;
      setGuides({ v: [], h: [] });
      onFinishEdit?.(commit);
    });
  };

  const pipPlacement = overlayDoc && pipCard && "id" in pipCard
    ? frameOf(overlayDoc, pipCard, getAspect())?.current : undefined;
  const pipParams = pipCard && pipPlacement?.mode === "auto" && "id" in pipCard
    ? restorePlacementParams(pipCard, pipPlacement) : pipCard?.params;
  const pipSource = pipParams?.camSrc || overlayCam;
  const refinedPip = (pipPlacement?.mode === "free" || pipPlacement?.mode === "group") && pipSource === videoUrl;
  const pip = overlayMode ? pipCard != null : pipCard != null && camIn;
  const pipClass = pipCard ? PIP_KINDS[pipCard.kind](pipParams) : "";

  return (
    <BreathContext.Provider value={!!breath}>
    <div className="canvas-wrap" ref={wrapRef}>
      <button type="button" className="canvas-safety-toggle" aria-pressed={showGuides} onClick={onToggleGuides}>
        安全区遮罩 {showGuides ? "开" : "关"}
      </button>
      <div
        ref={stageRef}
        onPointerDown={(event) => {
          if (!overlayMode || event.button !== 0) return;
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          onPickCard?.(null);
        }}
        data-sampled={overlayMode ? "" : undefined}
        className={`stage${isHud ? " is-hud" : ""}${glow ? "" : " no-glow"}${STAGE_H > STAGE_W ? " is-vertical" : ""}`}
        data-theme={theme}
        data-pip={pip && pipCard ? pipCard.kind : undefined}
        style={{
          width: STAGE_W,
          height: STAGE_H,
          transform: `translate(-50%, -50%) scale(${scale})`,
          ["--hud-scale" as string]: fxScale,
          ...(font ? { ["--hud-font" as string]: `"${font}"` } : {}),
          ...(vertical ? VERTICAL_STAGE_VARS : {}),
          ...inkVars(inkColor),
        }}
      >
        {/* 全屏视频垫底:导入真实口播画面实时预览 */}
        {videoUrl && (
          <video
            ref={(el) => {
              videoNodeRef.current = el;
              videoElRef?.(el);
            }}
            className={`stage-video${pip ? ` is-pip ${pipClass}` : ""}`}
            src={videoUrl}
            /* 缩角小窗时不叠加缩放,保证和落位框对齐 */
            style={
              pip && pipCard
                ? (() => {
                    // 人物聚焦精修版:满屏缩进方框按时间逐帧算,和卡里烤入导出是同一个 focusCamGeomAt
                    const c = pipCard as { start?: number; end?: number };
                    const timed = now !== undefined && c.start !== undefined;
                    const el = timed ? now - (c.start as number) : Infinity;
                    const dur = timed && c.end !== undefined ? c.end - (c.start as number) : Infinity;
                    const g = focusCamGeomAt(pipParams as any, el, dur);
                    return {
                      left: g.x,
                      top: g.y,
                      width: g.w,
                      height: g.h,
                      borderRadius: g.r,
                      objectFit: "cover",
                      objectPosition: "50% 45%",
                      opacity: refinedPip ? 0 : undefined,
                      ...(timed ? { transition: "none" } : {}),
                    } as React.CSSProperties;
                  })()
                : { transform: `scale(${videoScale ?? 1})`, ...(overlayMode ? { transition: "none" } : {}) }
            }
            autoPlay={!overlayMode}
            loop={!overlayMode}
            muted={overlayMode ? (videoMuted ?? false) : true}
            playsInline
            onLoadedMetadata={(e) => {
              alignPrimaryVideo(e.currentTarget);
              onVideoMeta?.(e.currentTarget.duration || 0);
            }}
            onError={(e) => {
              const el = e.target as HTMLVideoElement;
              const err = el.error;
              // 错误码 4 有两种截然不同的原因,却长得一模一样:一是编码真的放不了,
              // 二是文件根本没读全 —— 大视频写盘要时间,上传还没落完就点播放就会撞上。
              // 以前一律赖 H.265,用户就跑去重导一遍格式,白折腾。
              // 拿浏览器自己的解码能力来分辨:它连 H.265 都放得了,那锅就不在编码上。
              const hevcOk =
                el.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== "" &&
                el.canPlayType('video/mp4; codecs="hvc1.2.4.L120.B0"') !== "";
              const msg =
                err?.code !== 4
                  ? `视频加载失败(错误码 ${err?.code ?? "?"})`
                  : hevcOk
                    ? "这个视频读不出来。多半是还没传完就点了播放 —— 大文件写盘要几十秒。等一会儿刷新页面重新选一次;要是刷新后还这样,换个视频试试。"
                    : "浏览器不支持这个视频的编码(常见于 H.265/HEVC)。用剪映导出时选 H.264,或换 Chrome 试试。";
              alert(`❌ ${msg}`);
            }}
          />
        )}

        {/* 没有真实视频时的人物占位:提醒别把卡放到脸上 */}
        {showPerson && !videoUrl && (
          <div className="person" style={vertical ? {
            left: person.left,
            top: person.top,
            width: person.width,
            height: person.bottom - person.top,
            "--person-head": `${person.head}px`,
            "--person-gap": `${person.gap}px`,
          } as React.CSSProperties : undefined}>
            <div className="person-body" />
            <span className="person-tag">人物安全区</span>
          </div>
        )}

        {showGuides && <img className="canvas-safety-mask" src={vertical ? safePortrait : safeLandscape}
          alt="" aria-hidden="true" draggable={false} />}

        {/* 拖拽对齐辅助线:吸附命中时出现(左列脊柱/中线/其他卡的边和中心) */}
        {guides.v.map((x, i) => (
          <div key={`agv-${i}`} className="align-guide align-guide-v" style={{ left: x }} />
        ))}
        {guides.h.map((y, i) => (
          <div key={`agh-${i}`} className="align-guide align-guide-h" style={{ top: y }} />
        ))}

        {/* 时间轴模式:渲染当前时间点的所有卡片(同 seg 的进左列自动顺排容器) */}
        {overlayMode
          ? overlayDoc && <OverlayLayout doc={overlayDoc} time={now ?? 0} onLayout={updateLayout}
              render={(card, sample, measurement) => {
                const def = EFFECTS.find((e) => e.id === card.kind);
                if (!def) return null;
                const C = def.Component;
                const cardSide = (card.params.side as string) ?? "left";
                const chapterDrag = card.kind === "chapter-bar" && !measurement;
                // __t/__start/__end:时间感知卡据此高亮当前章、切字幕行
                const cardParams: Record<string, unknown> = {
                  ...card.params,
                  __t: sample,
                  __start: card.start,
                  __end: card.end,
                };
                if (card.kind === "focus-card") {
                  const source = (card.params.camSrc as string) || overlayCam;
                  const delayed = !!Number(card.params.camDelay);
                  const current = frameOf(overlayDoc, card, getAspect())?.current;
                  const refined = current?.mode === "free" || current?.mode === "group";
                  cardParams.camSrc = !measurement && source && (source !== videoUrl || delayed || refined) ? source : undefined;
                }
                return (
                    <CardShell
                      cardId={measurement ? null : card.id}
                      params={card.params}
                      stageScale={scale}
                      fxScale={fxScale}
                      animSpeed={animSpeed ?? 1}
                      frame={cardFrame(sample, card)}
                      time={sample}
                      start={card.start}
                      playing={!measurement && playing}
                      seekVersion={seekVersion}
                      onCardPointer={measurement ? undefined : (event) => beginPointer(event, card.id)}
                      onCardWheel={measurement ? undefined : (delta) => flushSync(() => onWheelCard?.(card.id, delta))}
                      chapterDrag={chapterDrag}
                    >
                      {def.selfPosition ? (
                        <C params={cardParams} playToken={1} />
                      ) : (
                        <div className={`slot slot-${cardSide}`}>
                          <C params={cardParams} playToken={1} />
                        </div>
                      )}
                    </CardShell>
                );
              }} />
          : /* 单特效预览:HUD 族自锚定;极简族落进左右槽 */
            <VerticalCardFit placement={params} band={vertical && effect.id !== "focus-card" ? verticalBand(effect.id, params) : undefined}>
              <CardShell
                cardId={null}
                params={params}
                stageScale={scale}
                fxScale={fxScale}
                animSpeed={animSpeed ?? 1}
                onNudge={onNudge}
                snapCtx={snapCtx}
              >
                {effect.selfPosition ? (
                  <Effect params={params} playToken={playToken} />
                ) : (
                  <div className={`slot slot-${side}`}>
                    <Effect params={params} playToken={playToken} />
                  </div>
                )}
              </CardShell>
            </VerticalCardFit>}
        {overlayMode && !playing && selectedCardId && selection && (() => {
          const group = moveGroup ? selection.group : undefined;
          const { x, y, w, h } = group?.box ?? selection.box;
          return <div className="card-edit-box" data-edit-card={selectedCardId} data-edit-group={group?.name}
            style={{ left: x, top: y, width: w, height: h }}>
            <button type="button" className="card-edit-label"
              onPointerDown={(event) => beginPointer(event, selectedCardId)}
              onWheel={(event) => flushSync(() => onWheelCard?.(selectedCardId, event.deltaY))}>
              {group ? `${group.name} · ${group.visibleCount} 张` : `${Number(selection.scale.toFixed(3))}×`}
            </button>
            {!group && [{ x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 0 }].map((corner) =>
              <button key={`${corner.x}${corner.y}`} type="button" className="card-edit-handle"
                aria-label={`${corner.x ? "左" : "右"}${corner.y ? "上" : "下"}角缩放`}
                style={{ left: `${(1 - corner.x) * 100}%`, top: `${(1 - corner.y) * 100}%`,
                  cursor: corner.x === corner.y ? "nwse-resize" : "nesw-resize" }}
                onPointerDown={(event) => beginPointer(event, selectedCardId, corner)} />)}
          </div>;
        })()}
      </div>
    </div>
    </BreathContext.Provider>
  );
}
