import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fps = 24;
const framingDuration = 4;
const alphaDuration = 2;
const start = 0.5;
const end = 1.5;
const aspects = [
  { name: "landscape", aspect: "16:9", width: 1920, height: 1080 },
  { name: "portrait", aspect: "9:16", width: 1080, height: 1920 },
];

function drawFramingChart(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  const edge = 32;
  const radius = 128;
  const centerX = width / 2;
  const centerY = height / 2;
  const colors = {
    top: [235, 24, 24],
    bottom: [24, 235, 24],
    left: [24, 48, 235],
    right: [235, 235, 24],
    circle: [235, 235, 235],
    background: [24, 24, 24],
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let color = colors.background;
      if (y < edge) color = colors.top;
      else if (y >= height - edge) color = colors.bottom;
      else if (x < edge) color = colors.left;
      else if (x >= width - edge) color = colors.right;
      else if ((x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2) color = colors.circle;
      pixels.set(color, (y * width + x) * 3);
    }
  }
  const samples = [
    { feature: "top", x: centerX, y: 16 },
    { feature: "bottom", x: centerX, y: height - 16 },
    { feature: "left", x: 16, y: centerY },
    { feature: "right", x: width - 16, y: centerY },
    { feature: "circle", x: centerX, y: centerY },
    { feature: "circle", x: centerX + radius - 8, y: centerY },
    { feature: "circle", x: centerX, y: centerY + radius - 8 },
    { feature: "background", x: centerX + radius + 8, y: centerY },
    { feature: "background", x: centerX, y: centerY + radius + 8 },
  ].map((point) => ({ ...point, rgb: colors[point.feature] }));
  const ppm = Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
  return { ppm, edge, radius, samples };
}

async function verifyVideo(command, path, expected) {
  const raw = await command("ffprobe", [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate,nb_read_frames,pix_fmt",
    "-of", "json", path,
  ]);
  const { streams: [video] } = JSON.parse(raw);
  assert.ok(video, "样片缺少视频流");
  assert.equal(video.width, expected.width);
  assert.equal(video.height, expected.height);
  assert.equal(video.codec_name, expected.codec);
  assert.equal(video.avg_frame_rate, `${fps}/1`);
  assert.equal(Number(video.nb_read_frames), fps * expected.duration);
  return video;
}

async function framingFixture(context, format) {
  const { evidenceDir, command } = context;
  const { name, aspect, width, height } = format;
  const { ppm, edge, radius, samples } = drawFramingChart(width, height);
  const source = join(evidenceDir, `${name}-chart.ppm`);
  const filename = `${name}-framing.mp4`;
  const path = join(evidenceDir, filename);
  await writeFile(source, ppm);
  try {
    await command("ffmpeg", [
      "-v", "error", "-n", "-loop", "1", "-framerate", String(fps), "-i", source,
      "-t", String(framingDuration), "-an", "-c:v", "libx264", "-threads", "2",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", path,
    ]);
  } finally {
    await rm(source, { force: true });
  }
  const media = await verifyVideo(command, path, { width, height, codec: "h264", duration: framingDuration });
  const pixels = await command("ffmpeg", [
    "-v", "error", "-ss", "1", "-i", path, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { encoding: "buffer", maxBuffer: width * height * 3 + 4096 });
  assert.equal(pixels.length, width * height * 3);
  for (const sample of samples) {
    const offset = (sample.y * width + sample.x) * 3;
    sample.decodedRgb = [...pixels.subarray(offset, offset + 3)];
    assert.ok(sample.decodedRgb.every((value, i) => Math.abs(value - sample.rgb[i]) <= 12),
      `${name} ${sample.feature} 色标与预期不同`);
  }

  const overlays = [];
  const cardsByPurpose = {
    focus: {
      id: "fixture-focus", kind: "focus-card", start, end: 3.5,
      params: { eyebrow: "聚焦切换测试", items: "测试要点一|测试要点二", sfx: "none" },
    },
    export: {
      id: "fixture-export", kind: "punch-pill", start, end,
      params: { text: "透明导出测试", sfx: "click" },
    },
  };
  for (const [purpose, card] of Object.entries(cardsByPurpose)) {
    const overlay = `${name}-${purpose}-overlay.json`;
    await writeFile(join(evidenceDir, overlay),
      JSON.stringify({ version: 1, aspect, theme: "dark", cards: [card] }, null, 2) + "\n");
    overlays.push({ purpose, file: overlay, activeRange: [card.start, card.end] });
  }
  const focusTimes = { before: 0.25, entering: 0.75, inside: 1.85, leaving: 2.85, after: 3.75 };
  return { aspect, file: filename, media, edge, radius, samples, overlays, focusTimes };
}

async function alphaFixture({ evidenceDir, command }) {
  // 独立参考片使用明确的 alpha 值和半开时间区间，便于测量解码和合成。
  const width = 320;
  const height = 180;
  const firstActive = start * fps;
  const afterActive = end * fps;
  const file = "alpha-reference.mov";
  const path = join(evidenceDir, file);
  const alpha = `if(between(N,${firstActive},${afterActive - 1})*between(Y,60,119),if(between(X,96,159),255,if(between(X,160,223),128,0)),0)`;
  await command("ffmpeg", [
    "-v", "error", "-n", "-filter_threads", "2", "-f", "lavfi", "-i",
    `color=s=${width}x${height}:r=${fps}:d=${alphaDuration},format=rgba`,
    "-vf", `geq=r=34:g=170:b=204:a='${alpha}'`, "-an",
    "-c:v", "qtrle", "-pix_fmt", "argb", path,
  ]);
  const media = await verifyVideo(command, path, { width, height, codec: "qtrle", duration: alphaDuration });
  const frameBytes = width * height;
  const bytes = await command("ffmpeg", [
    "-v", "error", "-i", path, "-vf", "alphaextract", "-f", "rawvideo",
    "-pix_fmt", "gray", "pipe:1",
  ], { encoding: "buffer", maxBuffer: frameBytes * fps * alphaDuration + 4096 });
  assert.equal(bytes.length, frameBytes * fps * alphaDuration);
  const samples = [
    { x: 48, y: 90, alpha: 0 },
    { x: 128, y: 90, alpha: 255 },
    { x: 192, y: 90, alpha: 128 },
  ];
  for (let frame = 0; frame < fps * alphaDuration; frame++) {
    for (const sample of samples) {
      const actual = bytes[frame * frameBytes + sample.y * width + sample.x];
      const expected = frame >= firstActive && frame < afterActive ? sample.alpha : 0;
      assert.equal(actual, expected, `参考片第 ${frame} 帧 alpha 与预期不同`);
    }
  }
  return { file, media, activeRange: [start, end], activeFrames: [firstActive, afterActive - 1], samples };
}

export async function generateFixtures(context) {
  const artifacts = [];
  for (const format of aspects) {
    await context.check(`${format.name}-framing`, async () => {
      const details = await framingFixture(context, format);
      artifacts.push(details.file, ...details.overlays.map(({ file }) => file));
      return details;
    });
  }
  await context.check("alpha-reference", async () => {
    const details = await alphaFixture(context);
    artifacts.push(details.file);
    return details;
  });
  await context.check("fixture-manifest", async () => {
    assert.equal(artifacts.length, aspects.length * 3 + 1, "测试素材未全部生成");
    const files = await Promise.all(artifacts.map(async (file) => {
      const contents = await readFile(join(context.evidenceDir, file));
      return { file, bytes: contents.length, sha256: createHash("sha256").update(contents).digest("hex") };
    }));
    const manifest = { type: "synthetic-fixtures", framingDuration, alphaDuration, fps, files };
    await writeFile(join(context.evidenceDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  });
}
