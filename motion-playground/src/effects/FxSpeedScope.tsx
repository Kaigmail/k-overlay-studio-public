import { createContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { FxSpeedContext } from "./useAnimation";

export const FxTimelineContext = createContext<{ time: number; playing: boolean; seekVersion: number } | null>(null);

/** 时间轴上的 CSS 关键帧由节目帧定位，效果库仍交给浏览器播放。 */
export function FxSpeedScope({ speed, time, start = 0, playing = false, seekVersion = 0, children }: {
  speed: number;
  time?: number;
  start?: number;
  playing?: boolean;
  seekVersion?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    for (const animation of element.getAnimations({ subtree: true })) {
      if (time === undefined) {
        animation.playbackRate = rate;
      } else if (animation instanceof CSSAnimation) {
        animation.pause();
        animation.currentTime = Math.max(0, time - start) * rate * 1000;
      }
    }
  });

  return (
    <div ref={ref} style={{ display: "contents" }}>
      <FxTimelineContext.Provider value={time === undefined ? null : { time, playing, seekVersion }}>
        <FxSpeedContext.Provider value={rate}>{children}</FxSpeedContext.Provider>
      </FxTimelineContext.Provider>
    </div>
  );
}
