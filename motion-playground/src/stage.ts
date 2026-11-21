/**
* 画布尺寸的唯一源头。
*
* 原版写死 16:9(1920×1080),竖屏口播(抖音/视频号)用不了。
* 现在画布由编排文件的 aspect 决定:
* - "16:9" 或缺省 → 1920×1080(与原版行为完全一致,旧编排不受影响)
* - "9:16" → 1080×1920
*
* STAGE 仍是同一个对象、原地改 w/h 不换引用:全仓读 STAGE 的地方(Canvas、
* ExportView、各卡组件)都是在渲染时读 STAGE.w/h,改完触发一次重渲染即可全场生效。
* 谁负责改:编辑台在编排载入/切换画布时调 setStage(App 的 effect),导出视图在
* 渲染前调(ExportView),导出脚本不走这里(它按 job.doc.aspect 自己算,见
* scripts/export-frames.mjs)。
*/
export type Aspect = "16:9" | "9:16";

export const STAGES: Record<Aspect, { w: number; h: number}> = {
"16:9": { w: 1920, h: 1080},
"9:16": { w: 1080, h: 1920},
};

export const STAGE = { w: 1920, h: 1080};

let currentAspect: Aspect = "16:9";

export function setStage(aspect: Aspect): void {
const s = STAGES[aspect]?? STAGES["16:9"];
STAGE.w = s.w;
STAGE.h = s.h;
currentAspect = aspect;
}

export function getAspect(): Aspect {
return currentAspect;
}

/** 从编排文件取画布:只有明确写了 "9:16" 才是竖屏,其余(缺省/非法值)一律横屏 */
export function aspectOfDoc(doc?: { aspect?: string} | null): Aspect {
return doc?.aspect === "9:16"? "9:16": "16:9";
}

/** 画板 1.png（1080×1920）的透明区域。右侧按钮从 y=769 开始占位。 */
export const VERTICAL_VISIBLE = { left: 59, top: 268, right: 1017, bottom: 1483, notchX: 887, notchY: 769 };

export const VERTICAL_PERSON = {
  left: 330, top: 712, width: 420, bottom: 1460, head: 250, gap: 12,
};

/** 布局线与平台遮挡之间留出空隙，容纳描边、阴影和轻微动画。 */
export const VERTICAL_LAYOUT = {
  chapter: { left: 79, top: 284, right: 997, bottom: 338 },
  upper: { left: 79, top: 352, right: 997, bottom: 690 },
  lower: { left: 79, top: 1010, right: 867, bottom: 1350 },
  caption: { left: 79, top: 1370, right: 867, bottom: 1460 },
} as const;

export type VerticalBand = keyof typeof VERTICAL_LAYOUT;

export function verticalBand(kind: string, params: Record<string, unknown>): VerticalBand {
  if (kind === "chapter-bar") return "chapter";
  if (kind === "caption-track") return "caption";
  const position = params.position ?? params.side;
  return position === "right" || position === "center" || position === "bottom" || params.centerOnStage === true ||
    kind === "versus-card" || kind === "ui-callout"
    ? "lower"
    : "upper";
}

export const VERTICAL_STAGE_VARS = {
  "--vertical-left": `${VERTICAL_LAYOUT.upper.left}px`,
  "--vertical-right": `${STAGES["9:16"].w - VERTICAL_LAYOUT.upper.right}px`,
  "--vertical-top": `${VERTICAL_LAYOUT.upper.top}px`,
  "--vertical-lower-center": `${(VERTICAL_LAYOUT.lower.left + VERTICAL_LAYOUT.lower.right) / 2}px`,
  "--vertical-lower-right": `${STAGES["9:16"].w - VERTICAL_LAYOUT.lower.right}px`,
  "--vertical-lower-bottom": `${STAGES["9:16"].h - VERTICAL_LAYOUT.lower.bottom}px`,
  "--vertical-caption-bottom": `${STAGES["9:16"].h - VERTICAL_LAYOUT.caption.bottom}px`,
} as Record<string, string>;

export interface StageGeom {
  sw: number;
  sh: number;
  vertical: boolean;
  edge: number;
  maxRightX: number;
  minLeftX: number;
  topEdge: number;
}

export function stageGeom(): StageGeom {
  const vertical = STAGE.h > STAGE.w;
  const { left, right, top } = VERTICAL_LAYOUT.upper;
  return vertical
    ? { sw: STAGE.w, sh: STAGE.h, vertical, edge: left, maxRightX: right, minLeftX: left, topEdge: top }
    : { sw: STAGE.w, sh: STAGE.h, vertical, edge: 120, maxRightX: 700, minLeftX: 1220, topEdge: 96 };
}
