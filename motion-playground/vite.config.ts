import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deliverMov, deliveryTarget, describeSubtitle, importSubtitleBytes, localRequest, productionApi, publishExport, saveOverlayJson, type RenderedExport } from './scripts/production-api.ts'
import type { Subtitle } from './src/overlay/production.ts'
import { resolveExport } from './src/overlay/export-preset.ts'

/** 上传落盘:写草稿 → 誊正。两件事必须守住 ——
 *
 *  一、草稿名要唯一。以前草稿固定叫「素材名.part」,同一个素材传两遍(前一遍还没传完
 *  又点了一次)时两次写的是同一份草稿,先完成的把它改名拿走,后完成的 renameSync 抛
 *  ENOENT。Mac 和 Windows 上都栽过这个坑。
 *
 *  二、誊正失败不许把服务带走。这个异常在流的回调里,中间件外面的 try/catch 兜不住,
 *  Vite 也没注册 uncaughtException —— 于是整个开发服务器进程直接退出。页面还在内存里,
 *  看着一切正常,但后台没了,此后每一次导入都失败。用户看到的就是这一幕。
 */
let uploadSeq = 0
function saveUpload(
  req: IncomingMessage,
  res: ServerResponse,
  dest: string,
  urlPath: string,
) {
  const tmp = `${dest}.${process.pid}-${Date.now()}-${++uploadSeq}.part`
  const ws = fs.createWriteStream(tmp)
  let settled = false
  // 所有出口都走这一个函数,而且整个包在 try 里。
  // 第二条守则的教训是「流回调里抛出的异常没人接」—— 那就不许任何一行裸奔:
  // rmSync 的 force 只忽略「文件不存在」,Windows 上文件被杀毒/索引器占着时照样抛 EPERM,
  // 以前 catch 里那句 rmSync 就是这么把服务带走的。
  const reply = (code: number, body: Record<string, unknown>) => {
    if (settled) return
    settled = true
    try {
      if (code !== 200) fs.rmSync(tmp, { force: true })
    } catch (e) {
      console.error(`[upload] 草稿删不掉(留着,下次启动再清):${tmp}`, e)
    }
    try {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    } catch (e) {
      console.error('[upload] 回应失败(多半是浏览器那头已断开):', e)
    }
  }
  // 先把写流关干净、等它真的关掉,再删草稿:Windows 上文件句柄还开着时删不掉
  const fail = (why: string) => {
    const done = () => reply(500, { ok: false, error: why })
    if (ws.closed) done()
    else {
      ws.once('close', done)
      ws.destroy()
    }
  }
  // 浏览器那头中途断开(刷新 / 关标签页 / 断网):pipe 只会解绑,finish 和 error 都不会来,
  // 草稿会永远留在磁盘上,而且改成唯一草稿名之后每断一次就多留一份。这里自己收尾。
  req.on('close', () => {
    if (!req.complete) fail('上传中断')
  })
  req.on('error', (e) => fail(String(e)))
  ws.on('error', (e) => fail(String(e)))
  ws.on('finish', () => {
    void (async () => {
      try {
        await renameWithRetry(tmp, dest)
        // 地址带上文件的修改时间:同名素材换了新版,地址跟着变,浏览器才会去拿新的。
        // 不带的话地址一个字都没变,页面会一直显示旧素材 —— 而导出的成片却是新的。
        const v = Math.floor(fs.statSync(dest).mtimeMs)
        // 两个接口的字段名不一样(/api/media 取 url,/api/upload-demo 取 src),都给,各取各的
        reply(200, { ok: true, url: `${urlPath}?v=${v}`, src: `${urlPath}?v=${v}` })
      } catch (e) {
        fail(`写入失败:${e}`)
      }
    })()
  })
  req.pipe(ws)
}

/**
 * 草稿誊正,失败了等一下再试。
 * Windows 上杀毒/索引器会短暂占住刚写完的文件,改名报 EPERM/EBUSY,过几百毫秒基本都能过。
 * 以前这里的退路是 copyFileSync:草稿和目标永远在同一个目录,「跨盘」根本不会发生;
 * 文件被占时复制一样失败;真跑起来还是几百 MB 的同步复制,会把单线程的服务卡死几十秒。
 */
async function renameWithRetry(tmp: string, dest: string) {
  const waits = [0, 200, 500, 1000]
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await new Promise((r) => setTimeout(r, waits[i]))
    try {
      fs.renameSync(tmp, dest)
      return
    } catch (e) {
      if (i === waits.length - 1) throw e
    }
  }
}

/** 导出透明动效层:POST /api/export → 起无头 Chrome 逐帧渲染 PNG 序列到 exports/ */
/** 音效:public/sfx/ 里放了同名文件就用它,没放就用随仓库附带的 CC0 默认音效(public/sfx-default/)。
 *  默认音效单独放一个文件夹,是为了不和你自己放进 public/sfx/ 的文件撞名 —— 撞名的话 git pull 会直接失败。 */
function sfxFallback(): Plugin {
  return {
    name: 'sfx-fallback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/sfx\/([^/?#]+\.mp3)(?:[?#].*)?$/.exec(req.url ?? '')
        if (!m) return next()
        let name: string
        try { name = path.basename(decodeURIComponent(m[1])) } catch { return next() }
        const pub = path.join(server.config.root, 'public')
        if (fs.existsSync(path.join(pub, 'sfx', name))) return next()
        const fallback = path.join(pub, 'sfx-default', name)
        if (!fs.existsSync(fallback)) return next()
        res.setHeader('Content-Type', 'audio/mpeg')
        fs.createReadStream(fallback).pipe(res)
      })
    },
  }
}

function overlayExport(): Plugin {
  let busy = false
  let desktopClosing = false
  let desktopCancelled = false
  type Destination = { directory: string; dev: bigint; ino: bigint }
  type SubtitleDestination = Destination & { subtitle: Subtitle; stem: string; round: number }
  const subtitleDestinations = new Map<string, SubtitleDestination>()
  const destinations = new Map<string, Destination>()
  let lastDestination: { destinationId: string | null; path: string } | undefined
  // 导出进度(GET /api/export-status 轮询用):从脚本 stdout 解析
  let prog: {
    running: boolean
    stage: string // prep | extract | frames | mov | webm | sfx | done
    frame: number
    total: number
    startedAt: number
    framesAt: number // 逐帧渲染开跑的时刻(0 = 还没开始),「预计还需」从这里起算
    ok?: boolean
    jobId?: string
    result?: object
  } = { running: false, stage: 'done', frame: 0, total: 0, startedAt: 0, framesAt: 0 }
  return {
    name: 'overlay-export',
    configureServer(server) {
      const defaultDirectory = path.join(server.config.root, 'exports', 'output')
      const sessionKey = process.env.OVERLAY_DESKTOP_SESSION
      const desktopWork = sessionKey && process.env.OVERLAY_DESKTOP_WORK
      if (desktopWork) {
        // Desktop skips watching generated frames. Serve them on demand without involving the dev watcher.
        server.middlewares.use('/_fxframes', async (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') return next()
          const match = /^\/(source-pts-v1-[a-f0-9]{20}-\d+ms|[\w.-]+-\d+_\d+fps-\d+-\d+s)\/(f_\d{5,}\.jpg)$/.exec((req.url ?? '').split('?')[0])
          if (!match) return next()
          if (!localRequest(req, false)) { res.statusCode = 403; res.end(); return }
          const frame = path.join(server.config.publicDir, '_fxframes', match[1], match[2])
          try {
            const info = await fs.promises.stat(frame)
            if (!info.isFile()) return next()
            res.setHeader('Content-Type', 'image/jpeg')
            res.setHeader('Content-Length', info.size)
            if (req.method === 'HEAD') { res.end(); return }
            const stream = fs.createReadStream(frame)
            stream.on('error', () => res.destroy())
            res.on('close', () => stream.destroy())
            stream.pipe(res)
          } catch {
            next()
          }
        })
      }
      const authorized = (req: IncomingMessage) => {
        if (!sessionKey || !localRequest(req, req.method !== 'GET')) return false
        const expected = Buffer.from(`Bearer ${sessionKey}`)
        const received = Buffer.from(req.headers.authorization ?? '')
        return received.length === expected.length && timingSafeEqual(received, expected)
      }
      server.middlewares.use('/api/desktop-session', (req, res) => {
        if (!sessionKey) { res.statusCode = 404; res.end(); return }
        if (!authorized(req)) { res.statusCode = 403; res.end(); return }
        req.resume()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        if (req.method === 'POST' && req.url === '/cancel' && desktopClosing) {
          // Once the service starts publishing, let it finish the file operation before closing.
          desktopCancelled = prog.stage !== 'publish' || !busy
        } else if (req.method === 'POST' && (req.url === '/close' || req.url === '/resume')) {
          desktopClosing = req.url === '/close'
        } else if (req.method !== 'GET' || req.url !== '/') {
          res.statusCode = 405
          res.end()
          return
        }
        res.end(JSON.stringify({ pid: process.pid, busy, lastDestination, canStop: desktopCancelled }))
      })
      const destinationFor = async (input: unknown, requireWritable = true): Promise<Destination> => {
        if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('请选择有效的成品目录。')
        const directory = await fs.promises.realpath(input)
        const info = await fs.promises.stat(directory, { bigint: true })
        if (!info.isDirectory()) throw new Error('选择的位置不是文件夹。')
        if (requireWritable) await fs.promises.access(directory, fs.constants.W_OK)
        return { directory, dev: info.dev, ino: info.ino }
      }
      const verifyRegisteredDirectory = async (destination: Destination) => {
        try {
          const current = await destinationFor(destination.directory)
          if (current.directory === destination.directory && current.dev === destination.dev && current.ino === destination.ino) return
        } catch { /* Return the same error for replaced, missing and read-only directories. */ }
        throw new Error('所选目录已失效或不可写，请重新选择。')
      }
      const readSubtitleBytes = async (file: string) => {
        const handle = await fs.promises.open(file, 'r')
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('请选择不超过 10 MB 的 SRT 文件。')
          return await handle.readFile()
        } finally {
          await handle.close()
        }
      }
      const agentFile = (output: SubtitleDestination) =>
        path.join(output.directory, `${output.stem}-Agent-${String(output.round).padStart(2, '0')}.json`)
      const latestRound = async (output: SubtitleDestination) => {
        const prefix = `${output.stem}-Agent-`.toLowerCase()
        const files = await fs.promises.readdir(output.directory)
        return files.reduce((highest, name) => {
          if (!name.toLowerCase().startsWith(prefix)) return highest
          const match = /^(\d{2,8})\.json$/i.exec(name.slice(prefix.length))
          return match ? Math.max(highest, Number(match[1])) : highest
        }, 0)
      }
      const outputInfo = async (destinationId: string, output: SubtitleDestination) => {
        const writable = await verifyRegisteredDirectory(output).then(() => true, () => false)
        return { destinationId, path: output.directory, subtitle: output.subtitle, agent: agentFile(output), writable }
      }
      const registerSubtitleOutput = async (directory: Destination, subtitle: Subtitle, stem: string) => {
        const destinationId = randomUUID()
        const output = { ...directory, subtitle, stem, round: 1 }
        output.round = Math.max(1, await latestRound(output))
        destinations.set(destinationId, directory)
        subtitleDestinations.set(destinationId, output)
        return outputInfo(destinationId, output)
      }
      server.middlewares.use('/api/subtitle-output', async (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        const nativePicker = req.url === '/import' || req.url === '/relocate'
        if (req.method !== 'POST' || !(nativePicker ? authorized(req) : localRequest(req))) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: '字幕输出仅限本机工作台。' }))
          return
        }
        try {
          let body = ''
          req.setEncoding('utf8')
          for await (const chunk of req) {
            body += chunk
            if (body.length > 16 * 1024 * 1024) throw new Error('请求内容太大。')
          }
          const input = JSON.parse(body)
          if (req.url === '/import') {
            if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || path.extname(input.path).toLowerCase() !== '.srt') {
              throw new Error('请选择有效的 SRT 文件。')
            }
            const source = await fs.promises.realpath(input.path)
            const name = path.basename(input.path)
            const bytes = await readSubtitleBytes(source)
            const selected = describeSubtitle(bytes, source, name)
            if (!selected) throw new Error('选中的 SRT 没有有效的字幕条目。')
            const destination = await destinationFor(path.dirname(input.path), false)
            const stem = (path.parse(name).name.slice(0, 120).trim() || '本期') + '-动效'
            const production = await importSubtitleBytes(name, bytes, path.dirname(server.config.root))
            const output = await registerSubtitleOutput(destination, selected.subtitle, stem)
            res.end(JSON.stringify({ production, output }))
            return
          }
          const output = subtitleDestinations.get(input.destinationId)
          if (!output) throw new Error('字幕输出目录已失效，请重新选择 SRT。')
          if (req.url === '/relocate') {
            res.end(JSON.stringify(await registerSubtitleOutput(await destinationFor(input.path), output.subtitle, output.stem)))
          } else if (req.url === '/next') {
            await verifyRegisteredDirectory(output)
            const latest = await latestRound(output)
            output.round = Math.max(output.round, latest) + 1
            res.end(JSON.stringify(await outputInfo(input.destinationId, output)))
          } else if (req.url === '/save') {
            await verifyRegisteredDirectory(output)
            res.end(JSON.stringify({ path: await saveOverlayJson(output.directory, output.stem, input.doc) }))
          } else if (req.url === '/read' || req.url === '/lines') {
            const selected = await describeSubtitle(await readSubtitleBytes(output.subtitle.path), output.subtitle.path, output.subtitle.relative)
            if (!selected || selected.subtitle.sha256 !== output.subtitle.sha256) {
              throw new Error('原始字幕内容已变更，请重新选择 SRT 并复制指令。')
            }
            if (req.url === '/lines') {
              res.end(JSON.stringify({ lines: selected.lines }))
              return
            }
            const file = agentFile(output)
            const info = await fs.promises.lstat(file).catch((error) => {
              if (error?.code === 'ENOENT') throw new Error(`尚未找到交稿：${file}`)
              throw error
            })
            if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Agent 交稿应为有效的 JSON 文件，且不能超过 16 MB。')
            const bytes = await fs.promises.readFile(file)
            const identity = createHash('sha256').update(output.directory).update('\0').update(output.subtitle.path).update('\0').update(bytes).digest('hex')
            res.end(JSON.stringify({ ...selected, text: new TextDecoder().decode(bytes), identity }))
          } else {
            res.statusCode = 404
            res.end(JSON.stringify({ error: '此目录操作不存在。' }))
          }
        } catch (error) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      })
      server.middlewares.use('/api/export-destination', async (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.method !== 'POST' || !authorized(req)) {
          res.statusCode = 403
          res.end(JSON.stringify({ ok: false, error: '目录登记需要当前桌面会话授权。' }))
          return
        }
        try {
          let body = ''
          req.setEncoding('utf8')
          for await (const chunk of req) {
            body += chunk
            if (body.length > 32_768) throw new Error('目录登记请求过长。')
          }
          const destination = await destinationFor(JSON.parse(body).path)
          const destinationId = randomUUID()
          destinations.set(destinationId, destination)
          res.end(JSON.stringify({ ok: true, destinationId, path: destination.directory }))
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: '所选目录无效或不可写，请重新选择。' }))
        }
      })
      // 导入的视频落盘成一个真实路径:blob 地址刷新即失效,每次都要重新导入。
      // 存进 public/_media/ 之后,刷新后按 URL 自动恢复;这个路径无头 Chrome 也能读,
      // 所以它同时可以当运镜卡的「口播视频」用。
      server.middlewares.use('/api/media', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.method !== 'POST') { res.statusCode = 405; res.end('{"ok":false}'); return }
        const raw = String(req.headers['x-filename'] ?? 'video')
        // 文件名只留安全字符,防止 ../ 之类写到目录外
        const safe = decodeURIComponent(raw).replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(-80)
        // 新版素材使用独立地址，避免同名上传改掉已导出编排里的素材引用。
        const name = `${randomUUID()}-${safe}`
        const dir = path.join(server.config.root, 'public', '_media')
        fs.mkdirSync(dir, { recursive: true })
        saveUpload(req, res, path.join(dir, name), `/_media/${encodeURIComponent(name)}`)
      })

      server.middlewares.use('/api/export-status', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ ...prog, defaultDirectory, lastDestination }))
      })
      server.middlewares.use('/api/export', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        res.setHeader('Content-Type', 'application/json')
        if (busy || desktopClosing) {
          res.statusCode = 429
          res.end(JSON.stringify({ ok: false, error: desktopClosing ? '编辑台正在关闭' : '已有导出任务在进行中' }))
          return
        }
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (c) => (body += c))
        req.on('end', async () => {
          if (busy || desktopClosing) {
            res.statusCode = 429
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: desktopClosing ? '编辑台正在关闭' : '已有导出任务在进行中' }))
            return
          }
          busy = true
          desktopCancelled = false
          const jobId = randomUUID()
          const stageDir = path.join(desktopWork || path.join(server.config.root, 'exports'), `.staged-${jobId}`)
          let jobFile: string | undefined
          try {
            const job = JSON.parse(body || '{}')
            resolveExport(job)
            if (job.delivery && !localRequest(req)) throw new Error('本期交付仅限本机工作台')
            const target = job.delivery ? await deliveryTarget(job.delivery) : null
            const destinationId = job.destinationId as string | undefined
            const destination = destinationId && localRequest(req) ? destinations.get(destinationId) : undefined
            if (destinationId !== undefined && !destination) throw new Error('导出目录选择已失效，请重新选择。')
            const directory = destination?.directory ?? defaultDirectory
            const verifyDirectory = async () => {
              if (!destination) {
                await fs.promises.mkdir(defaultDirectory, { recursive: true })
                return
              }
              await verifyRegisteredDirectory(destination)
            }
            await verifyDirectory()
            delete job.delivery
            job.base = `http://localhost:${server.config.server.port ?? 5177}`
            job.stageOnly = true
            job.stageKey = jobId
            jobFile = path.join(desktopWork || os.tmpdir(), `overlay-export-${jobId}.json`)
            fs.writeFileSync(jobFile, JSON.stringify(job), { flag: 'wx' })

            const child = spawn(process.execPath, ['scripts/export-frames.mjs', jobFile], {
              cwd: server.config.root,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
            prog = { running: true, stage: 'prep', frame: 0, total: 0, startedAt: Date.now(), framesAt: 0, jobId }
            let out = ''
            let err = ''
            // 看门狗:子进程 15 分钟没有任何输出就当它假死,强制停掉。不设的话 busy 永远是 true,
            // 之后每次点导出都是「已有导出任务在进行中」,只能重启服务。15 分钟留给最慢的静默
            // 阶段(长视频抽帧、ProRes 合成都不打进度);脚本内部另有 30 秒的单帧超时兜常见情况。
            const IDLE_MS = 15 * 60_000
            const giveUp = () => {
              err +=
                '\n【导出失败原因】导出 15 分钟没有任何进展,已强制停止。多半是渲染器假死了:' +
                '重新导出一次;还不行就重启 npm run dev。'
              child.kill('SIGKILL')
            }
            let idle = setTimeout(giveUp, IDLE_MS)
            const kick = () => {
              clearTimeout(idle)
              idle = setTimeout(giveUp, IDLE_MS)
            }
            child.stdout.on('data', (d) => {
              kick()
              out += d
              process.stdout.write(`[export] ${d}`)
              // 从累计输出的尾部解析进度(行可能被分块截断,所以每次都从全文找最后一条)
              const m = [...out.matchAll(/progress (\d+)\/(\d+)/g)].pop()
              if (m) {
                prog.frame = Number(m[1])
                prog.total = Number(m[2])
                prog.stage = 'frames'
              }
              // 视频抽帧(长录屏要几分钟):单独一个阶段,别一直显示「启动渲染器」
              if (prog.stage === 'prep' && out.includes('extracting video frames'))
                prog.stage = 'extract'
              // 逐帧渲染开跑:记下时刻,「预计还需」只按这之后的耗时算
              if (!prog.framesAt && out.includes('rendering frames:')) {
                prog.framesAt = Date.now()
                prog.stage = 'frames'
              }
              if (out.includes('composing MOV')) prog.stage = 'mov'
              if (out.includes('composing WebM')) prog.stage = 'webm'
              if (out.includes('baking')) prog.stage = 'sfx'
            })
            child.stderr.on('data', (d) => {
              kick()
              err += d
            })
            child.once('error', (error) => { err += String(error) })
            child.on('close', async (code) => {
              clearTimeout(idle)
              let finalResult: { ok: boolean; [key: string]: unknown }
              try {
                if (desktopCancelled) throw new Error('已取消导出')
                if (code !== 0) throw new Error(err.slice(-800) || '渲染进程退出')
                const lines = out.trim().split('\n')
                const rendered: RenderedExport = JSON.parse(lines[lines.length - 1])
                delete rendered.stageDir
                prog.stage = 'publish'
                const files = await publishExport(rendered, directory, verifyDirectory)
                const mov = files.mov?.path ?? null
                const webm = files.webm?.path ?? null
                const pngOnly = job.preset === undefined && !destination && rendered.ok && !rendered.mov && !rendered.webm
                const errors = Object.entries(files).flatMap(([key, item]) =>
                  item.error ? [`${key}: ${item.error}`] : [])
                const ok = pngOnly || (rendered.ok && !!mov && !!webm && errors.length === 0)
                finalResult = {
                  ...rendered, ok, jobId, mov, webm, files, outputDirectory: directory,
                  sfxSheet: files.sfxSheet?.path, camNote: files.camNote?.path,
                  error: ok ? undefined : [rendered.error, ...errors].filter(Boolean).join(' '),
                }
                if (mov && target) Object.assign(finalResult, await deliverMov(mov, target))
                if (mov && webm && !subtitleDestinations.has(destinationId ?? '') && ((destinationId && destination) || desktopWork)) {
                  lastDestination = { destinationId: destinationId ?? null, path: directory }
                  finalResult.lastDestination = lastDestination
                }
              } catch (error) {
                res.statusCode = 500
                finalResult = { ok: false, jobId, error: String(error) }
              } finally {
                await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(console.error)
                if (jobFile) await fs.promises.rm(jobFile, { force: true }).catch(console.error)
              }
              prog = { ...prog, running: false, stage: 'done', ok: finalResult.ok, result: finalResult }
              try {
                res.end(JSON.stringify(finalResult))
              } finally {
                busy = false
              }
            })
          } catch (e) {
            if (jobFile) await fs.promises.rm(jobFile, { force: true }).catch(console.error)
            busy = false
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: String(e) }))
          }
        })
      })
    },
  }
}

/** 录屏上传:POST /api/upload-demo?name=xxx.mp4(原始字节流)→ 存进 public/demo/,返回可用路径 */
function demoUpload(): Plugin {
  return {
    name: 'demo-upload',
    configureServer(server) {
      server.middlewares.use('/api/upload-demo', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        try {
          const q = new URL(req.url ?? '', 'http://x').searchParams
          // 只留文件名本体,防路径穿越;空格等字符统一成下划线
          const raw = decodeURIComponent(q.get('name') || 'demo.mp4')
          const name = path.basename(raw).replace(/[^\w.一-龥()-]/g, '_')
          const dir = path.join(server.config.root, 'public', 'demo')
          fs.mkdirSync(dir, { recursive: true })
          // 先写临时文件再改名:用户在文件选择器里选中 public/demo 里的同名文件时,
          // 直接写 dest 会一边读一边截断源文件(自毁);临时文件+rename 则安全覆盖
          saveUpload(req, res, path.join(dir, name), `/demo/${name}`)
        } catch (e) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: String(e) }))
        }
      })
    },
  }
}

/** 学习闭环:POST /api/review-log → 把「AI 初选 vs 用户终选」存进 exports/review-logs/,供「学一下」用 */
function reviewLog(): Plugin {
  return {
    name: 'review-log',
    configureServer(server) {
      server.middlewares.use('/api/review-log', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            JSON.parse(body) // 只校验是合法 JSON,原样落盘
            const dir = path.join(server.config.root, 'exports', 'review-logs')
            fs.mkdirSync(dir, { recursive: true })
            const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
            const dest = path.join(dir, `${stamp}-review-log.json`)
            fs.writeFileSync(dest, body)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, file: dest }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ ok: false, error: String(e) }))
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), sfxFallback(), productionApi(), overlayExport(), demoUpload(), reviewLog()],
  server: {
    port: 5177, // K-Overlay-Studio 固定端口,避免和其他项目的 5173/5174 混淆
    // 端口被占时**报错退出**,不许自己顺延到 5178。
    // 顺延是个隐蔽的坑:localStorage 按 origin 隔离,5177 和 5178 是两套存档,
    // 编排会"看起来丢了";启动器又是写死 curl/open 5177 的,顺延后浏览器还会打不开。
    // 宁可起不来报一句"5177 被占了",也不要静悄悄换个门牌。
    strictPort: true,
    open: true, // 启动后自动打开浏览器
  },
})
