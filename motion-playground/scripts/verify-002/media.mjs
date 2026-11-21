import assert from "node:assert/strict";

const raw = { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 };

function decoder(format) {
  return format === "webm" ? ["-c:v", "libvpx-vp9"] : [];
}

function countMask(bytes, frameSize, threshold) {
  const active = [];
  for (let offset = 0; offset < bytes.length; offset += frameSize) {
    if (bytes.subarray(offset, offset + frameSize).some((value) => value > threshold)) {
      active.push(offset / frameSize);
    }
  }
  return active;
}

async function probe(context, file) {
  return JSON.parse(await context.command("ffprobe", [
    "-v", "error", "-count_frames", "-show_streams", "-of", "json", file,
  ])).streams;
}

export async function verifyMedia(context, file, format, expected) {
  const streams = await probe(context, file);
  const video = streams.find((stream) => stream.codec_type === "video");
  assert.ok(video, `${file} 缺少视频流`);
  assert.equal(video.width, expected.width);
  assert.equal(video.height, expected.height);
  assert.equal(Number(video.nb_read_frames), expected.frames);
  assert.equal(video.avg_frame_rate === "0/0" ? video.r_frame_rate : video.avg_frame_rate, expected.rate);
  if (format === "mov") {
    assert.equal(video.codec_name, "prores");
    assert.equal(video.profile, "4444");
    for (const field of ["color_space", "color_primaries", "color_transfer"]) assert.equal(video[field], "bt709");
  } else {
    assert.equal(video.codec_name, "vp9");
  }
  const measurement = { file, video };
  if (!expected.alpha) return measurement;

  const timeline = await context.command("ffmpeg", [
    "-v", "error", ...decoder(format), "-i", file, "-vf", "alphaextract,scale=320:180",
    "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], raw);
  assert.equal(timeline.length, expected.frames * 320 * 180);
  const active = countMask(timeline, 320 * 180, 5);
  assert.ok(active.length > 0, "动效未进入成品");
  assert.ok(Math.abs(active[0] - expected.fps * 0.5) <= 1, `首个动效帧为 ${active[0]}`);
  assert.ok(Math.abs(active.at(-1) + 1 - expected.fps * 1.5) <= 1, `最后动效帧为 ${active.at(-1)}`);
  measurement.active = [active[0], active.at(-1)];
  if (format === "mov") {
    assert.equal(streams.find((stream) => stream.codec_type === "audio")?.codec_name, "pcm_s16le");
    const audio = await context.command("ffmpeg", [
      "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
    ], raw);
    let onset = 0;
    while (onset < audio.length / 2 && Math.abs(audio.readInt16LE(onset * 2)) < 160) onset++;
    measurement.audioOnset = onset / 8000;
    assert.ok(Math.abs(measurement.audioOnset - 0.5) <= 1 / expected.fps, `音效起点 ${measurement.audioOnset}s`);
  }
  return measurement;
}

async function sampleRgba(context, file, format, width, height) {
  const pixels = await context.command("ffmpeg", [
    "-v", "error", ...decoder(format), "-ss", "1", "-i", file, "-frames:v", "1",
    "-vf", `scale=${width}:${height}:flags=bicubic,format=rgba`, "-f", "rawvideo", "pipe:1",
  ], raw);
  assert.equal(pixels.length, width * height * 4);
  return pixels;
}

function bounds(pixels, width) {
  let left = width, right = 0, top = Infinity, bottom = 0;
  for (let index = 0; index < pixels.length / 4; index++) {
    if (pixels[index * 4 + 3] < 40) continue;
    const x = index % width, y = Math.floor(index / width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  assert.ok(left < right && top < bottom, "不透明区域没有有效边界");
  return [left, top, right, bottom];
}

export async function compareMedia(context, pair, horizontal) {
  const width = horizontal ? 1280 : 720;
  const height = horizontal ? 720 : 1280;
  const images = {};
  for (const resolution of ["1080p", "720p"]) {
    images[resolution] = {};
    const files = pair[resolution];
    for (const format of ["mov", "webm"]) {
      images[resolution][format] = await sampleRgba(context, files[format], format, width, height);
    }
  }
  const framing = {};
  for (const format of ["mov", "webm"]) {
    const high = bounds(images["1080p"][format], width);
    const low = bounds(images["720p"][format], width);
    const deltas = high.map((value, i) => Math.abs(value - low[i]));
    assert.ok(deltas.every((value) => value <= 2), `${format} 构图边界差 ${deltas}`);
    framing[format] = { high, low, deltas };
  }
  const compositing = {};
  for (const resolution of ["1080p", "720p"]) {
    const { mov, webm } = images[resolution];
    const totals = [0, 0];
    let transparent = 0, opaque = 0, feather = 0;
    for (let i = 0; i < mov.length; i += 4) {
      const alpha = mov[i + 3] / 255;
      const other = webm[i + 3] / 255;
      if (alpha < 0.02 && other < 0.02) transparent++;
      if (alpha > 0.98 && other > 0.98) opaque++;
      if (alpha < 0.15 || alpha > 0.85 || Math.abs(alpha - other) > 0.08) continue;
      feather++;
      for (let channel = 0; channel < 3; channel++) {
        for (const [j, background] of [24, 232].entries()) {
          const fromMov = mov[i + channel] + background * (1 - alpha);
          const fromWebm = webm[i + channel] * other + background * (1 - other);
          totals[j] += Math.abs(fromMov - fromWebm);
        }
      }
    }
    assert.ok(transparent > 100 && opaque > 100 && feather > 20, "透明、实体或半透明像素不足");
    const meanError = totals.map((value) => value / (3 * feather));
    assert.ok(meanError.every((value) => value <= 22), `${resolution} 双底色半透明合成误差 ${meanError}`);
    compositing[resolution] = { transparent, opaque, feather, meanError };
  }
  return { framing, compositing };
}
