import { useLayoutEffect, useRef, type ReactNode } from "react";
import { STAGE, VERTICAL_LAYOUT, type VerticalBand } from "../stage";

/** 预览和导出共用：保留卡片原有排版，把整体落进指定的竖屏区域。 */
export function VerticalCardFit({ band, placement, children }: { band?: VerticalBand; placement?: Record<string, unknown>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const applied = useRef({ x: 0, y: 0, scale: 1 });
  const manualX = Number(placement?.manualX) || 0;
  const manualY = Number(placement?.manualY) || 0;
  const measure = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const layer = ref.current;
    const stage = layer?.closest<HTMLElement>(".stage");
    if (!band || !layer || !stage) {
      applied.current = { x: 0, y: 0, scale: 1 };
      return;
    }
    const region = VERTICAL_LAYOUT[band];
    let roots: Element[] = [];

    const fit = () => {
      const stageBox = stage.getBoundingClientRect();
      const zoom = stageBox.width / STAGE.w;
      if (!zoom || !roots.length) return;
      const { x, y, scale } = applied.current;
      // 反解上一次的位移与缩放，避免每帧重置样式再读布局。
      // 手调位移在自动落位之后生效，反算时先扣掉它。
      const manual = layer.style.translate.split(" ").map(parseFloat);
      const manualX = manual[0] || 0;
      const manualY = manual[1] || 0;
      const boxes = Array.from(roots, (root) => root.getBoundingClientRect());
      const left = ((Math.min(...boxes.map((b) => b.left)) - stageBox.left) / zoom - x - manualX) / scale;
      const right = ((Math.max(...boxes.map((b) => b.right)) - stageBox.left) / zoom - x - manualX) / scale;
      const top = ((Math.min(...boxes.map((b) => b.top)) - stageBox.top) / zoom - y - manualY) / scale;
      const bottom = ((Math.max(...boxes.map((b) => b.bottom)) - stageBox.top) / zoom - y - manualY) / scale;
      if (right <= left || bottom <= top) return;
      const nextScale = Math.min(1, (region.right - region.left) / (right - left), (region.bottom - region.top) / (bottom - top));
      const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
      // 缩放时保留原中心，再把自动落位超出区域的部分推回。
      const nextX = clamp((left + right) / 2 * (1 - nextScale), region.left - left * nextScale, region.right - right * nextScale);
      const nextY = clamp((top + bottom) / 2 * (1 - nextScale), region.top - top * nextScale, region.bottom - bottom * nextScale);
      if (Math.abs(nextX - x) < 0.02 && Math.abs(nextY - y) < 0.02 && Math.abs(nextScale - scale) < 0.00002) return;
      applied.current = { x: nextX, y: nextY, scale: nextScale };
      layer.style.transform = `translate(${nextX}px, ${nextY}px) scale(${nextScale})`;
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
