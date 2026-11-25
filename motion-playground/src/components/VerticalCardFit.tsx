import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { Box } from "../overlay/placement";
import { STAGE, VERTICAL_LAYOUT, type VerticalBand } from "../stage";

export function fitBox(box: Box, region: { left: number; right: number; top: number; bottom: number }, scale?: number) {
  const { x, y, w, h } = box;
  const fit = scale ?? Math.min(1, (region.right - region.left) / w, (region.bottom - region.top) / h);
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  return {
    scale: fit,
    x: clamp((x + w / 2) * (1 - fit), region.left - x * fit, region.right - (x + w) * fit),
    y: clamp((y + h / 2) * (1 - fit), region.top - y * fit, region.bottom - (y + h) * fit),
  };
}

/** 预览和导出共用：保留卡片原有排版，把整体落进指定的竖屏区域。 */
export function VerticalCardFit({ band, placement, children }: { band?: VerticalBand; placement?: Record<string, unknown>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const manualX = Number(placement?.manualX) || 0;
  const manualY = Number(placement?.manualY) || 0;
  const measure = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const layer = ref.current;
    const stage = layer?.closest<HTMLElement>(".stage");
    if (!band || !layer || !stage) return;
    const region = VERTICAL_LAYOUT[band];
    let roots: Element[] = [];

    const fit = () => {
      const stageBox = stage.getBoundingClientRect();
      const zoom = stageBox.width / STAGE.w;
      if (!zoom || !roots.length) return;
      // 在未自动位移的画布上测量，避免前一帧的亚像素取整影响当前帧。
      const previous = layer.style.transform;
      layer.style.transform = "";
      const [manualX = 0, manualY = 0] = layer.style.translate.split(" ").map(parseFloat);
      const boxes = roots.map((root) => root.getBoundingClientRect());
      const left = (Math.min(...boxes.map((b) => b.left)) - stageBox.left) / zoom - manualX;
      const right = (Math.max(...boxes.map((b) => b.right)) - stageBox.left) / zoom - manualX;
      const top = (Math.min(...boxes.map((b) => b.top)) - stageBox.top) / zoom - manualY;
      const bottom = (Math.max(...boxes.map((b) => b.bottom)) - stageBox.top) / zoom - manualY;
      if (right <= left || bottom <= top) {
        layer.style.transform = previous;
        return;
      }
      const { scale: nextScale, x: nextX, y: nextY } = fitBox({ x: left, y: top, w: right - left, h: bottom - top }, region);
      layer.dataset.fit = String(nextScale);
      if (nextX !== 0 || nextY !== 0 || nextScale !== 1) {
        layer.style.transform = `translate(${nextX}px, ${nextY}px) scale(${nextScale})`;
      }
    };

    const resize = new ResizeObserver(fit);
    const watch = () => {
      const next = Array.from(layer.querySelectorAll(".hud:not(.ctrack), .ctrack-cue, .slot"));
      if (next.length === roots.length && next.every((node, index) => node === roots[index])) return;
      roots.forEach((node) => resize.unobserve(node));
      roots = next;
      roots.forEach((node) => resize.observe(node));
      fit();
    };
    const mutations = new MutationObserver(watch);
    mutations.observe(layer, { childList: true, subtree: true });
    measure.current = fit;
    watch();
    return () => {
      measure.current = null;
      resize.disconnect();
      mutations.disconnect();
    };
  }, [band]);
  useLayoutEffect(() => { measure.current?.(); });

  if (!band) return children;
  return <div ref={ref} className="vertical-card-fit" data-band={band} style={{ translate: `${manualX}px ${manualY}px` }}>{children}</div>;
}
