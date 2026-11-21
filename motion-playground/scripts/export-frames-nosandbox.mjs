// 容器入口沿用同一导出实现，只在本次调用关闭 Chromium 沙箱。
process.argv.push("--no-sandbox");
await import("./export-frames.mjs");
