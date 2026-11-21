import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

// The host owns all descendants before releasing this start gate.
const [start] = await new Promise((resolve) => {
  process.stdin.once("data", (data) => resolve(data.toString().trim().split(/\s+/)));
  process.stdin.once("end", () => resolve([]));
});
process.stdin.pause();
if (start !== "start" || !process.env.OVERLAY_DESKTOP_SESSION) process.exit(1);

let server;
try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error("请安装 Node 22.12 或更高版本。");
  if (!existsSync("node_modules/vite/package.json")) throw new Error("缺少编辑台依赖，请先在项目目录运行 npm install。");
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const probe = spawnSync(tool, ["-version"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
    if (probe.status !== 0) throw new Error("找不到可用的 " + tool + "，请检查 FFmpeg 安装及 PATH。");
  }
  const { default: puppeteer } = await import("puppeteer");
  const rendererFile = new URL("bin/renderer-path.txt", import.meta.url);
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH
    || (existsSync(rendererFile) ? readFileSync(rendererFile, "utf8").trim() : "");
  const renderer = configured || await puppeteer.executablePath().catch(() => "");
  if (!renderer || !isAbsolute(renderer) || !statSync(renderer, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(configured
      ? "指定的导出浏览器不存在。请重新构建桌面版并选择可用的渲染浏览器。"
      : "找不到导出浏览器。请在项目目录运行 npx puppeteer browsers install chrome。");
  }
  process.env.PUPPETEER_EXECUTABLE_PATH = renderer;
  const { createServer } = await import("vite");
  server = await createServer({
    server: {
      host: "localhost", port: 5177, strictPort: true, open: false,
      watch: { ignored: ["**/public/_fxframes", "**/public/_fxframes/**", "**/exports", "**/exports/**"] },
    },
  });
  await server.listen();
  console.log("OVERLAY_DESKTOP_READY");
} catch (error) {
  console.error(error.message);
  await server?.close();
  process.exitCode = 1;
}
