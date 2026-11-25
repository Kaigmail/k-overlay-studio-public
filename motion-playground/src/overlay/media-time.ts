/** 节目秒到素材秒。循环只重播 clip 起点之后的区间。 */
export function mediaTime(
  time: number,
  { start = 0, clip = 0, rate = 1, loop = false, duration }: {
    start?: number;
    clip?: number;
    rate?: number;
    loop?: boolean;
    duration: number;
  },
): number {
  const from = Math.min(Math.max(0, clip), duration);
  const offset = Math.max(0, time - start) * rate;
  const span = duration - from;
  if (loop && span > 0) return from + offset % span;
  return Math.min(from + offset, duration);
}

/** 取素材时间戳不晚于目标时刻的最后一帧。 */
export function sourceFrameAt(time: number, timestamps: readonly number[]): number {
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (timestamps[mid] <= time + 1e-9) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}
