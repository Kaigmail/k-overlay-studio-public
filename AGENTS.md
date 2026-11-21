# AGENTS.md — K-Overlay-Studio 开发说明(给 Codex / Claude Code 等 Agent)

## 这个仓库是什么

口播动效编辑台 [jeszhou/overlay-studio](https://github.com/jeszhou/overlay-studio)(作者:一页枝鸥)
的授权二次开发版本，以 **9:16 竖屏(抖音/视频号)** 为主、16:9 兼容。
方法:20 张动效卡预先做好,AI 只读 SRT 挑卡编排成 JSON,编辑台里人工微调,导出透明 MOV 进剪映。

- 本仓库为 Kai 的非商业授权发布版。上游署名、许可和发布范围见 [发布与署名](DISTRIBUTION.md)。
- 使用者从 [README](README.md) 和 [Windows 快速开始](WINDOWS.md) 开始。
- 已与上游分叉,**不做上游合并**。确需挑拣上游更新时手工 cherry-pick 并全量回归(见验证协议)。

## 常用命令(在 motion-playground/ 下)

```bash
npm install          # 首次装依赖(会顺带下载导出用的无头 Chrome)
npm run dev          # 编辑台 http://localhost:5177
npm run build        # tsc + vite build,提交前必跑
npm run check:cards  # 卡库自检:默认文案/缓动/四入口 skill 同步,提交前必跑
npm run sync:cards   # 改了卡表或默认文案后同步 skill 四入口
```

环境:Node ≥ 22.12(仓库根有 .nvmrc)、ffmpeg(导出用)。项目路径须纯英文无空格。

Windows 从 `motion-playground/start-k-overlay-studio.bat` 启动、`stop-k-overlay-studio.bat` 停止。macOS 从 `motion-playground/start-k-overlay-studio.command` 启动，终端按 Ctrl+C 停止。旧脚本转到新入口。上游署名、许可原文、本机存储键和 `Projects/overlay-studio` 交稿路径保留原值。

## 架构地图(改之前先看这里)

| 位置 | 职责 |
|---|---|
| `motion-playground/src/stage.ts` | 画布唯一源头:`STAGE`/`setStage(aspect)`/`aspectOfDoc()`、画板可见区 `VERTICAL_VISIBLE` 和落位区 `VERTICAL_LAYOUT`、**几何入口 `stageGeom()`** |
| `motion-playground/src/effects/hud/hud.css` | 卡的共享锚点 CSS(`.hud-anchor--*`);`.stage.is-vertical` 段是竖屏三带落位覆盖 |
| `motion-playground/src/effects/hud/accent.ts` | 强调色语义(色义 A,见不变量) |
| `motion-playground/src/effects/hud/camGeom.ts` | focus-card 人物框几何(含竖屏分支) |
| `motion-playground/src/fonts.ts` | `src/assets/fonts/` 字体自动注册(文件名「家族名-字重」约定) |
| `motion-playground/src/overlay/` | 编排 JSON 的类型、解析(`parseOverlay` 会把卡定义默认值合并进 params)、lint |
| `motion-playground/src/ExportView.tsx` | 导出视图(无头 Chrome 逐帧渲染的入口) |
| `motion-playground/scripts/export-frames.mjs` | 导出脚本:读 job JSON `{doc, fps, duration, base}`,画布跟随 doc.aspect |
| `.claude/.agents/.codebuddy/.workbuddy/skills/overlay-fx-generator/` | AI 编排 skill 四入口,内容必须保持一致;`我的偏好.md` 是仓库主人的定版规则 |

20 张卡全部是 `selfPosition`:落位 = hud.css 共享锚点 + 卡内几何常量,**没有槽位系统**。

## 不变量(硬规则,不要「优化」掉)

1. **横屏零回归**:16:9 时 `stageGeom()` 的返回值必须与原版常量逐一相等
   (edge 120 / maxRightX 700 / minLeftX 1220 / topEdge 96)。改任何几何先想横屏会不会变。
2. **竖屏安全区以《画板 1》为准**：1080×1920 上，可见区 x=59–1017、y=268–1483；从 y=769 起，右界收至 x=887。
   共享几何在 `stage.ts`；下带底边 y=1350，字幕 y=1370–1460。白模脸在上下带之间。
3. **色义 A 案**:颜色不表涨跌(内容横跨 A 股与美股,红绿含义相反)。
   蓝=数据/中性、红=否定/风险、橙=转变、绿=达成/正向。涨跌只能用文字/箭头。
   `accent.ts` 里 green 映射到 `--hud-green` 是刻意恢复的,别再别名回蓝色。
4. **卡内几何只走 `stageGeom()`**:不许在卡组件里写死 1920/1080/画布边距/人脸线;
   新卡同样处理。竖屏预览和导出都用同一套落位约束，居中卡进脸下带。
5. **改卡必同步**:改卡表、默认文案、卡参数后跑 `npm run sync:cards`,
   并保证 `check:cards` 通过(它会校验四个 skill 入口一致)。
6. **《我的偏好.md》四份保持一致且必须入库**:根 `.gitignore` 已加 fork 例外放行;
   不要恢复原版「偏好只留本机」的忽略规则。
7. **字体定版**:默认 `--hud-font` 栈思源优先(Noto Sans SC / Source Han Sans SC / 思源黑体 / 苹方 / 雅黑);
   字体文件本身不入库(授权原因),靠使用者放进 `src/assets/fonts/` 或系统安装。
8. **编排内容可信**:skill 生成编排 JSON 时,卡面数字/涨跌幅/排名必须来自字幕稿或可核查来源,
   禁止编造(细则在《我的偏好.md》,这里只作提醒,不要在代码里绕开)。

## 验证协议(改完怎么算过)

1. `npm run build` + `npm run check:cards` 必须全过。
2. 动了几何/落位/画幅:必须实际渲染核对——起 `npm run dev`,用导出视图
   (`?export=1` + 注入 `window.__EXPORT_DOC`)截 9:16 与 16:9 各一帧,确认:
   竖屏卡落在安全区内、横屏与改前一致。只看代码不算验证。
3. 动了导出链:用 job JSON 跑一小段(12 帧即可)`scripts/export-frames.mjs`,
   确认 MOV 为对应画幅(9:16 → ProRes 1080×1920、30fps)。
   本机非 root 用原版脚本;root/容器环境才用 `scripts/export-frames-nosandbox.mjs`。

## 已知边界(是取舍,不是 bug)

- focus-card 竖屏要点区超高时走滚动模式,这是设计内行为。
- 导出很吃磁盘(1 分钟成片约 4.5GB 中间 PNG)和 CPU:长片导出只在本机跑;
  `exports/` 里除 `output/` 外都是可删的中间产物。
- 内置示例有两份:横屏 `public/demo/demo-overlay.json`(顶栏「示例」按钮加载)
  和竖屏 `public/demo/demo-916-overlay.json`(拖进编辑台用)。

## 提交约定

- 小步提交,提交信息用中文、一句话说清改了什么。
- 不要提交:`node_modules/`、`dist/`、`exports/`、字体文件、视频文件、`.env` 等本地配置
  (根 `.gitignore` 已覆盖大部分,新增大文件前先确认)。
- 二次开发在独立分支完成，并通过验证后再合并。
  P1–P4 完成时的已知良好状态,只作回滚参照,不要往上提交。
