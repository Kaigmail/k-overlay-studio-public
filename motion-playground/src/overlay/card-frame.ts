import { outroFade, type OverlayCard } from "./types";

/** CSS ease = cubic-bezier(.25, .1, .25, 1). 反算横坐标以保留原来的让位手感。 */
function ease(progress: number): number {
  if (progress <= 0 || progress >= 1) return Math.max(0, Math.min(1, progress));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const u = (lo + hi) / 2;
    const x = 0.75 * u * (1 - u) + u ** 3;
    if (x < progress) lo = u;
    else hi = u;
  }
  const u = (lo + hi) / 2;
  return 0.3 * u * (1 - u) ** 2 + 3 * u ** 2 * (1 - u) + u ** 3;
}

export function cardFrame(time: number, card: Pick<OverlayCard, "start" | "end" | "params">) {
  const dimAt = Number(card.params.dimAt);
  const past = dimAt > 0 && time >= dimAt;
  const dim = past ? ease((time - dimAt) / 0.9) : 0;
  const outro = outroFade(time, card);
  return {
    past,
    outro: outro < 1 ? outro : undefined,
    style: {
      "--fx-dim-opacity": 1 - dim * 0.55,
      "--fx-dim-saturation": 1 - dim * 0.3,
      "--fx-dim-scale": 1 - dim * 0.4,
      "--fx-outro": outro < 1 ? outro : undefined,
    },
  };
}
