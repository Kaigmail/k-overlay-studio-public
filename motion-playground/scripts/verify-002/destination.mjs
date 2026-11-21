import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tsImport } from "tsx/esm/api";

export async function jsonRequest(url, route, body, authorization) {
  const response = await fetch(url + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Connection: "close",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  return { status: response.status, data: await response.json() };
}

export async function registerDirectory(url, directory, session) {
  const registration = await jsonRequest(url, "/api/export-destination", { path: directory }, session);
  assert.equal(registration.status, 200, JSON.stringify(registration.data));
  assert.equal(registration.data.path, directory);
  return registration.data;
}

export async function verifyDestination(context, { url, session, directory, registered, job, sample }) {
  const request = (route, body) => jsonRequest(url, route, body);
  await context.check("unauthorized-directory", async () => {
    const result = await request("/api/export-destination", { path: directory });
    assert.equal(result.status, 403);
    return result;
  });
  await context.check("chunked-chinese-directory", async () => {
    const target = join(context.evidenceDir, "中文目录分段");
    await mkdir(target);
    const payload = Buffer.from(JSON.stringify({ path: target }));
    const split = payload.lastIndexOf(Buffer.from("中")) + 1;
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(url + "/api/export-destination", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}`, Connection: "close" },
      }, async (res) => {
        try {
          res.setEncoding("utf8");
          let body = "";
          for await (const chunk of res) body += chunk;
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (error) { reject(error); }
      });
      req.on("error", reject);
      req.setTimeout(6_000, () => req.destroy(new Error("登记中文目录超时")));
      req.write(payload.subarray(0, split));
      void delay(100).then(() => req.end(payload.subarray(split)));
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.path, target);
    return { path: response.data.path };
  });
  await context.check("invalidated-directory", async () => {
    const removed = join(context.evidenceDir, "失效目录");
    await mkdir(removed);
    const target = await registerDirectory(url, removed, session);
    await rename(removed, removed + "-moved");
    const result = await request("/api/export", { ...job, destinationId: target.destinationId });
    assert.equal(result.status, 400);
    assert.match(result.data.error, /失效|不可写/);
    const status = await request("/api/export-status");
    assert.equal(status.data.lastDestination.destinationId, registered.destinationId);
    return { rejected: result.data, retained: status.data.lastDestination.path };
  });

  if (!sample) {
    context.skip("destination-files", "缺少实际编码成品。");
    return;
  }
  const { publishExport } = await tsImport("../production-api.ts", import.meta.url);
  await context.check("collision-and-partial-publish", async () => {
    const target = join(context.evidenceDir, "发布冲突");
    await mkdir(target);
    const existing = join(target, basename(sample.mov));
    await writeFile(existing, "已有同名文件", { flag: "wx" });
    let checks = 0;
    const published = await publishExport(sample, target, async () => {
      if (++checks === 4) throw new Error("演练 WebM 在发布前目标失效");
    });
    assert.equal(await readFile(existing, "utf8"), "已有同名文件");
    assert.ok(published.mov.path && published.mov.path !== existing);
    assert.deepEqual(await readFile(published.mov.path), await readFile(sample.mov));
    assert.match(published.webm.error, /发布前目标失效/);
    assert.equal((await readdir(target)).some((file) => file.endsWith(".part")), false);
    return published;
  });

  await context.check("broll-retry-and-same-directory", async () => {
    const production = join(context.evidenceDir, "制作交付");
    const output = join(production, "Video", "B-roll");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, "演练误占目录", { flag: "wx" });
    const response = await request("/api/export", { ...job, delivery: { root: production } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.ok(response.data.ok && response.data.retry && response.data.mov, JSON.stringify(response.data));
    await rename(output, output + "-blocked");
    const retry = await request("/api/production/retry-mov", { retry: response.data.retry });
    assert.equal(retry.status, 200);
    assert.equal(dirname(retry.data.path), output);
    assert.deepEqual(await readFile(retry.data.path), await readFile(response.data.mov));

    const selected = await registerDirectory(url, output, session);
    const same = await request("/api/export", { ...job, delivery: { root: production }, destinationId: selected.destinationId });
    assert.ok(same.data.ok, JSON.stringify(same.data));
    assert.equal(same.data.delivered, same.data.mov);
    return { recovered: retry.data.path, sameDirectory: same.data.mov };
  });
}
