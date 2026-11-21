import { aspectOfDoc, STAGES } from "../stage.ts";

export type ExportPreset = {
  resolution: "720p" | "1080p";
  fps: 24 | 30 | "30000/1001";
};

function rateOf(value: unknown) {
  if (value === "30000/1001" ||
    (typeof value === "number" && Math.abs(value - 29.97) < 0.01)) {
    return { numerator: 30000, denominator: 1001, argument: "30000/1001" };
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("帧率必须是正数。");
  }
  return { numerator: value, denominator: 1, argument: Number.isInteger(value) ? `${value}/1` : String(value) };
}

export function resolveExport(job: {
  doc?: { aspect?: string } | null;
  preset?: unknown;
  fps?: unknown;
  duration?: unknown;
}) {
  const aspect = aspectOfDoc(job.doc);
  const stage = STAGES[aspect];
  const duration = job.duration === undefined ? 6 : job.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("导出时长必须是正数。");
  }
  let resolution: ExportPreset["resolution"] = "1080p";
  let rate = rateOf(job.fps === undefined ? 30 : job.fps);
  if (job.preset !== undefined) {
    const preset = job.preset as Partial<ExportPreset> | null;
    if (preset?.resolution !== "720p" && preset?.resolution !== "1080p") {
      throw new Error("导出清晰度仅支持 720p 或 1080p。");
    }
    resolution = preset.resolution;
    const legacy = aspect === "16:9" && resolution === "1080p" && preset.fps === "30000/1001";
    if (preset.fps !== 24 && preset.fps !== 30 && !legacy) {
      throw new Error("此画幅与清晰度不支持所选帧率。");
    }
    const preferred = rateOf(preset.fps);
    if (job.fps !== undefined && rate.argument !== preferred.argument) {
      throw new Error("预设与旧 fps 字段冲突。");
    }
    rate = preferred;
  }
  const ratio = resolution === "720p" ? 2 / 3 : 1;
  const fps = rate.numerator / rate.denominator;
  let frames = Math.max(1, Math.ceil(duration * rate.numerator / rate.denominator));
  if (!Number.isSafeInteger(frames)) throw new Error("导出帧数超出支持范围。");
  // 按实际采样表达式校正小数边界，避免恰好落在 duration 的帧被纳入。
  if (frames > 1 && (frames - 1) * rate.denominator / rate.numerator >= duration) frames--;
  return {
    aspect, stage, resolution, rate, fps, duration, frames,
    width: Math.round(stage.w * ratio),
    height: Math.round(stage.h * ratio),
  };
}
