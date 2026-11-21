// 一次性:把 extra/sfx-pack.json 里的默认音效(base64)还原到 motion-playground/public/sfx-default/
// 快照推送只能传文本文件,mp3 以 base64 形式随仓库走;clone 后在仓库根目录跑一次: node extra/restore-assets.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pack = JSON.parse(readFileSync(join(root, "extra", "sfx-pack.json"), "utf8"));
const outDir = join(root, "motion-playground", "public", "sfx-default");
mkdirSync(outDir, { recursive: true });
for (const [name, b64] of Object.entries(pack)) {
  writeFileSync(join(outDir, name), Buffer.from(b64, "base64"));
  console.log("restored", name);
}
console.log("done:", Object.keys(pack).length, "files");
