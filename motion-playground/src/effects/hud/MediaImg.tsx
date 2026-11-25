import { useContext, useLayoutEffect, useRef, type CSSProperties } from "react";
import { FxTimelineContext } from "../FxSpeedScope";
import { mediaTime } from "../../overlay/media-time";
import { imgRetry } from "./imgRetry";

const IS_EXPORT =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("export") === "1";

export const isVideoSrc = (src: string) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(src);

export function FxVideo({ src, className, tStart = 0, clipStart = 0, loop = false, rate = 1, style }: {
  src: string;
  className?: string;
  tStart?: number;
  clipStart?: number;
  loop?: boolean;
  rate?: number;
  style?: CSSProperties;
}) {
  const timeline = useContext(FxTimelineContext);
  const clip = Math.max(0, clipStart);
  const speed = rate > 0 ? rate : 1;
  const ref = useRef<HTMLVideoElement>(null);
  const version = useRef<number | undefined>(undefined);
  const latest = useRef(timeline);
  latest.current = timeline;

  const align = (video: HTMLVideoElement) => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const sample = latest.current;
    video.playbackRate = speed;
    if (!sample) {
      if (video.currentTime < clip) video.currentTime = clip;
      return;
    }
    const target = mediaTime(sample.time, { start: tStart, clip, rate: speed, loop, duration: video.duration });
    const playing = sample.playing && sample.time >= tStart && (loop || target < video.duration);
    const jumped = version.current !== sample.seekVersion;
    version.current = sample.seekVersion;
    const exact = Math.abs(video.currentTime - target);
    if (!playing) video.pause();
    if (exact > (playing && !video.paused && !jumped ? 0.1 : 0.0001)) video.currentTime = target;
    const ready = !video.seeking && video.readyState >= 2 && (playing || exact <= 0.0001);
    video.dataset.frameReady = String(ready);
    video.style.visibility = ready ? "" : "hidden";
    if (playing && ready && video.paused) void video.play().catch(() => {});
  };

  useLayoutEffect(() => {
    if (ref.current) align(ref.current);
  });

  if (IS_EXPORT) {
    return <img
      className={className}
      data-fx-vidimg
      data-fx-src={src}
      data-t-start={tStart}
      data-fx-clip={clip}
      data-fx-rate={speed}
      data-fx-loop={loop ? "1" : undefined}
      style={style}
      alt=""
    />;
  }

  return <video
    key={src}
    ref={ref}
    className={className}
    data-fx-video
    src={src}
    muted
    playsInline
    preload="auto"
    autoPlay={!timeline}
    loop={!timeline || (loop && clip === 0)}
    style={{ ...style, visibility: timeline ? "hidden" : style?.visibility }}
    onLoadedMetadata={(e) => align(e.currentTarget)}
    onLoadedData={(e) => align(e.currentTarget)}
    onSeeked={(e) => align(e.currentTarget)}
    onTimeUpdate={timeline ? undefined : (e) => align(e.currentTarget)}
    onError={(e) => {
      const video = e.currentTarget;
      const retry = Number(video.dataset.retry ?? 0);
      if (retry < 3) {
        video.dataset.retry = String(retry + 1);
        setTimeout(() => { if (video.isConnected) video.load(); }, 400);
      }
    }}
  />;
}

export function MediaImg({ src, className, tStart }: { src: string; className?: string; tStart?: number }) {
  if (isVideoSrc(src)) return <FxVideo src={src} className={className} tStart={tStart} loop />;
  return <img className={className} src={src} alt="" onError={imgRetry(src)} />;
}
