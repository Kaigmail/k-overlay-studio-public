# K-Overlay-Studio

K-Overlay-Studio 是 Kai 的口播动效工作台。导入 SRT，让外部 Agent 从现成的动效卡中挑选和编排，再在画布与时间轴上调整，最后导出可供剪映导入的透明 MOV。

- 20 张动效卡，支持竖屏 9:16 和横屏 16:9。
- 在编辑台调整文字、时间和位置，按需显示安全区参考图。
- 支持本机预览和渲染。导出 ProRes 4444 透明 MOV 和透明 WebM，提供 720p、1080p 与 24、30 fps 预设。
- Agent 通过可编辑的 JSON 交稿。带有短 SRT 和候选 JSON，可先体验编辑与导出。

## 试用 Windows 预览版

在 [GitHub Releases](https://github.com/Kaigmail/k-overlay-studio-public/releases) 下载 Windows x64 ZIP。解压后按[快速开始](WINDOWS.md)安装本机依赖、打开工作台，或查看 Release 中的实机演示。

## 从源码运行

在项目根目录执行：

```bash
node extra/restore-assets.mjs
cd motion-playground
npm ci
npm run dev
```

打开 http://localhost:5177。透明导出还需要 FFmpeg、ffprobe 与 Puppeteer 使用的浏览器。需要自行编译 Windows 桌面启动器时，在同一目录执行 `npm run build:desktop`。修改卡片或代码后运行 `npm run build` 和 `npm run check:cards`。

## 署名与使用范围

K-Overlay-Studio 由 Kai 开发和维护，基于一页枝鸥（Jessie Zhou）的 [Overlay Studio](https://github.com/jeszhou/overlay-studio) 获授权二次开发。这个发布版限非商业用途，Windows 构建可通过 GitHub Releases 免费下载。原作者署名和原始许可随仓库保留。详见[发布与署名](DISTRIBUTION.md)。
