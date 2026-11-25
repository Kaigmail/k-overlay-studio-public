import { inkVars } from "./effects/hud/accent";
import { BreathContext } from "./effects/breath";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import "./fonts"; // 自定义字体注册:导出端也要有 @font-face,成片字体才和预览一致
import { EFFECTS } from "./effects/registry";
import { FxSpeedScope } from "./effects/FxSpeedScope";
import { parseOverlay, type OverlayCard, type OverlayDoc } from "./overlay/types";
import { cardFrame } from "./overlay/card-frame";
import { mediaTime, sourceFrameAt } from "./overlay/media-time";
import { STAGE, setStage, aspectOfDoc, VERTICAL_STAGE_VARS } from "./stage";
import { OverlayLayout } from "./components/OverlayLayout";
import "./effects/hud/hud.css";
import "./App.css";

/**
 * 导出专用视图(?export=1)
 * 只渲染动效本体:透明背景、无视频、无人物、无参考线、无UI。
 * 渲染整条时间轴(&doc=<overlay json>),卡片按 start/end 出现;
 * 导出脚本逐帧传入节目时间，React 提交后才读取目标素材。
 */

function renderCard(
  card: OverlayCard,
  fxScale: number,
  jobSpeed: number,
  t: number,
  cam?: string,
  measurement = false,
) {
  const def = EFFECTS.find((e) => e.id === card.kind);
  if (!def) return null;
  const C = def.Component;
  const side = (card.params.side as string) ?? "left";
  // __start:让卡内视频知道自己相对整条时间轴的起点
  // __t/__end:让时间感知卡(章节条/字幕层)拿到时间轴当前秒和自己的终点
  const params: Record<string, unknown> = { ...card.params, __start: card.start, __t: t, __end: card.end };
  // 运镜卡的口播:单卡没传就用全局口播(doc.cam),按时间轴自动对位
  if (cam && !params.camSrc) params.camSrc = cam;
  if (measurement) params.camSrc = undefined;
  // 每卡缩放/倍速 × 全局值,和 Studio 预览一致
  const scale = fxScale * (Number(card.params.scale) || 1);
  const speed = jobSpeed * (Number(card.params.speed) || 1);
  const { past, outro, style } = cardFrame(t, card);
  return (
      <div
        style={{
          display: "contents",
          ["--hud-scale" as string]: scale,
          ...style,
        }}
        /* 逐卡主题:与 Studio 预览一致 */
        data-card-theme={(card.params.theme as string) || undefined}
        data-card-id={measurement ? undefined : card.id}
        data-past={past ? "1" : undefined}
        data-outro={outro === undefined ? undefined : "1"}
        data-dim-mode={(card.params.dimMode as string) || undefined}
      >
        <FxSpeedScope speed={speed} time={t} start={card.start}>
          {def.selfPosition ? (
            <C params={params} playToken={1} />
          ) : (
            <div className={`slot slot-${side}`}>
              <C params={params} playToken={1} />
            </div>
          )}
        </FxSpeedScope>
      </div>
  );
}

const stageStyle = (scale: number) => {
  const { w, h } = STAGE;
  return {
    position: "fixed",
    left: 0,
    top: 0,
    width: w,
    height: h,
    ["--hud-scale" as string]: scale,
    ...(h > w ? VERTICAL_STAGE_VARS : {}),
  } as React.CSSProperties;
};

/** 导出渲染直接取被请求的节目帧。 */
function TimelineExport({ doc, scale, speed }: { doc: OverlayDoc; scale: number; speed: number }) {
  const [t, setT] = useState(-1);
  useEffect(() => {
    const target = window as Window & { __setExportT?: (sec: number) => void; __startExport?: () => void };
    const sample = (time: number) => flushSync(() => setT(time));
    target.__setExportT = sample;
    target.__startExport = () => sample(0);
    return () => {
      delete target.__setExportT;
      delete target.__startExport;
    };
  }, []);

  return (
    <BreathContext.Provider value={doc.breath === true}>
      <div
        className={`stage is-hud is-export${doc.glow ? "" : " no-glow"}${aspectOfDoc(doc) === "9:16" ? " is-vertical" : ""}`}
        data-sampled
        data-theme={doc.theme ?? "dark"}
        style={{
          ...stageStyle(scale),
          ...(doc.font ? { ["--hud-font" as string]: `"${doc.font}"` } : {}),
          ...inkVars(doc.inkColor),
        }}
      >
        {t >= 0 && <OverlayLayout doc={doc} time={t}
          render={(card, sample, measurement) => renderCard(card, scale, speed, sample, doc.cam, measurement)} />}
      </div>
    </BreathContext.Provider>
  );
}

export function ExportView() {
  const q = new URLSearchParams(location.search);
  useEffect(() => {
    document.documentElement.classList.add("export-mode");
    const target = window as Window & {
      __VID_FRAMES?: Record<string, {
        dir: string;
        timestamps: number[];
        dur: number;
      }>;
      __seekVideos?: (time: number) => Promise<void>;
    };
    target.__seekVideos = async (time) => {
      const images = Array.from(document.querySelectorAll<HTMLImageElement>("img[data-fx-vidimg]"));
      await Promise.all(images.map(async (image) => {
        const asset = image.dataset.fxSrc ?? "";
        const media = target.__VID_FRAMES?.[asset];
        if (!media?.timestamps.length) {
          throw new Error(`卡内视频无法读取或抽帧，请检查素材路径并重新导出：${asset}`);
        }
        const seconds = mediaTime(time, {
          start: Number(image.dataset.tStart),
          clip: Number(image.dataset.fxClip),
          rate: Number(image.dataset.fxRate),
          loop: image.dataset.fxLoop === "1",
          duration: media.dur,
        });
        const frame = sourceFrameAt(seconds, media.timestamps);
        const source = `${media.dir}/f_${String(frame + 1).padStart(5, "0")}.jpg`;
        if (image.getAttribute("src") !== source) image.src = source;
        await image.decode().catch((error) => {
          throw new Error(`卡内视频帧解码失败：${asset}（源帧索引 ${frame}）`, { cause: error });
        });
      }));
    };
    return () => { delete target.__seekVideos; };
  }, []);

  const speed = Number(q.get("spd") ?? 1) || 1;
  // 编排优先读导出脚本注入的 __EXPORT_DOC(整份编排走 URL 会超长 → HTTP 431);
  // URL 的 ?doc= 仅作短编排/手工调试的兜底
  const injected = (window as unknown as { __EXPORT_DOC?: string }).__EXPORT_DOC;
  const { doc, error } = parseOverlay(injected ?? q.get("doc") ?? "{}");
  if (error || !doc) return <div style={{ color: "red" }}>{error}</div>;
  // 画布跟随编排(Kai fork · P1):必须在 TimelineExport 渲染前把 STAGE 设好,
  // 它和各卡组件渲染时读的都是同一个 STAGE。脚本侧的 viewport 尺寸由
  // scripts/export-frames.mjs 按 doc.aspect 另行对齐,两边一致才不拉伸。
  setStage(aspectOfDoc(doc));
  // 烤入人物的卡:这几段导出后在剪映里要盖掉原始口播轨,否则会看到两层人。
  // 判断依据是卡有没有 camSrc 控件(不写死卡名,以后新加的卡自动算进来)。
  // 时间段挂到 window,导出脚本读了在成品旁边生成一份「合成说明」——
  // 用户打开 exports/output/ 拿 MOV 的那一刻,正好是他要去剪映的前一秒。
  (window as unknown as { __CAM_SEGMENTS?: unknown }).__CAM_SEGMENTS = doc.cards
    .filter((c) => {
      const def = EFFECTS.find((e) => e.id === c.kind);
      const takesCam = def?.controls?.some((x) => (x as { key?: string }).key === "camSrc");
      return takesCam && (c.params.camSrc || doc.cam);
    })
    .map((c) => ({ kind: c.kind, start: c.start, end: c.end }));
  return <TimelineExport doc={doc} scale={Number(q.get("fx") ?? 1)} speed={speed} />;
}
