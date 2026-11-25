import assert from "node:assert/strict";
import { mediaTime, sourceFrameAt } from "../../src/overlay/media-time.ts";
import { frameAtOrBefore, frameAtOrAfter, frameTime, isVisibleAt, resolveExport, visibleFrameRange } from "../../src/overlay/export-preset.ts";

export function verifyFrames() {
  const presets = [
    { aspect: "9:16", fps: 24, numerator: 24, denominator: 1 },
    { aspect: "9:16", fps: 30, numerator: 30, denominator: 1 },
    { aspect: "16:9", fps: "30000/1001", numerator: 30000, denominator: 1001 },
  ];
  for (const { aspect, fps, numerator, denominator } of presets) {
    const preset = { resolution: "1080p", fps };
    const duration = 12 * denominator / numerator;
    const { rate, frames } = resolveExport({ doc: { aspect }, preset, duration });
    assert.deepEqual([rate.numerator, rate.denominator, frames], [numerator, denominator, 12]);
    const at = (index) => index * denominator / numerator;
    for (const index of [0, 1, 7, 11, 12, 247, 11113]) {
      assert.equal(frameTime(index, rate), at(index));
      assert.equal(frameAtOrAfter(at(index), rate), index);
      assert.equal(frameAtOrBefore(at(index), rate), index);
      assert.equal(frameAtOrBefore(at(index + 0.9), rate), index);
      assert.equal(frameAtOrAfter(at(index + 0.1), rate), index + 1);
    }
    assert.equal(frameTime(frames - 1, rate), at(11));
    assert.equal(frameTime(frames, rate), duration);
    assert.equal(resolveExport({ doc: { aspect }, preset, duration: at(12.1) }).frames, 13);
    const before = { start: at(0), end: at(7) };
    const after = { start: at(7), end: duration };
    assert.equal(isVisibleAt(at(6), before), true);
    assert.equal(isVisibleAt(at(7), before), false);
    assert.equal(isVisibleAt(at(7), after), true);
    assert.equal(isVisibleAt(at(12), after), false);
    assert.deepEqual(visibleFrameRange(before, rate, frames), { first: 0, endExclusive: 7 });
    assert.deepEqual(visibleFrameRange(after, rate, frames), { first: 7, endExclusive: 12 });
    assert.deepEqual(visibleFrameRange({ start: -1, end: at(1.1) }, rate, frames), { first: 0, endExclusive: 2 });
    assert.equal(visibleFrameRange({ start: at(1.1), end: at(1.2) }, rate, frames), null);
    assert.equal(visibleFrameRange({ start: at(12), end: at(13) }, rate, frames), null);
    assert.equal(visibleFrameRange({ start: -1, end: 0 }, rate, frames), null);
  }
  assert.equal(mediaTime(1, { start: 2, clip: 0.25, duration: 3 }), 0.25);
  assert.equal(mediaTime(1.5, { clip: 0.5, rate: 2, loop: true, duration: 2.5 }), 1.5);
  assert.equal(mediaTime(4, { duration: 3 }), 3);
  assert.equal(sourceFrameAt(1.1 - 0.11, [0, 23 / 24, 1, 25 / 24]), 1);
  assert.equal(sourceFrameAt(34 / 30 - 0.11, [0, 23 / 24, 1, 25 / 24]), 2);
  assert.throws(() => resolveExport({ fps: 30, duration: Number.MAX_VALUE }), /帧数/);
  return { presets: presets.map(({ fps }) => fps), checks: ["精确边界与下一帧", "相邻卡交接", "末帧", "无可采样帧", "素材偏移、回环与源时间戳"] };
}
