/**
 * DSH desktop notifier — Host half.
 *
 * Observes agent lifecycle events and exposes them through two transports:
 *
 * - an SSE endpoint (`/dsh-notifier/events`) consumed by the Client half, which
 *   raises browser notifications;
 * - a Windows toast raised by spawning PowerShell from WSL.
 *
 * The page reports its Notification permission over `/dsh-notifier/client-state`
 * so a granted browser channel suppresses duplicate Windows toasts.
 */

import { spawn } from 'node:child_process'

/** Services this plugin needs before it may activate. */
export const inject = ['webServer', 'agents']

const ROUTE_PREFIX = '/dsh-notifier'
const NOTICE_KINDS = ['test', 'completed', 'error', 'approval', 'question']
const HEARTBEAT_MS = 20_000
const CLIENT_STALE_MS = 5 * 60_000
const RECENT_ERROR_MS = 15_000
const MAX_SEEN = 500

/**
 * Normalize the Loader row config; every field is optional.
 * @param {object | undefined} raw
 */
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const events = c.events && typeof c.events === 'object' ? c.events : {}
  const toast = c.windowsToast && typeof c.windowsToast === 'object' ? c.windowsToast : {}
  const browser = c.browser && typeof c.browser === 'object' ? c.browser : {}
  const toastMode =
    toast.enabled === true
      ? 'always'
      : toast.enabled === false
        ? 'never'
        : toast.enabled === 'always' || toast.enabled === 'never'
          ? toast.enabled
          : 'auto'
  return {
    events: {
      completed: events.completed !== false,
      error: events.error !== false,
      approval: events.approval !== false,
      question: events.question !== false,
    },
    browser: { enabled: browser.enabled !== false },
    windowsToast: {
      enabled: toastMode,
      command: typeof toast.command === 'string' && toast.command ? toast.command : 'powershell.exe',
      appId:
        typeof toast.appId === 'string' && toast.appId ? toast.appId : 'DSH.Web',
      sound: toast.sound !== false,
      launchUrl: typeof toast.launchUrl === 'string' ? toast.launchUrl : '',
    },
    debounceMs: Number.isFinite(c.debounceMs) && c.debounceMs >= 0 ? Number(c.debounceMs) : 4000,
    includeSubagents: c.includeSubagents === true,
  }
}

/**
 * Last path segment of a directory, for compact notification copy.
 * @param {string | undefined} path
 */
function basename(path) {
  if (!path) return ''
  const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

/** Truncate by Unicode code points without splitting a surrogate pair. */
function truncate(text, limit) {
  const value = String(text || '')
  const points = [...value]
  return points.length <= limit ? value : `${points.slice(0, limit - 1).join('')}…`
}

/** Turn an unknown thrown value into one notification line. */
function errorText(error) {
  if (error == null) return ''
  if (typeof error === 'string') return truncate(error.replace(/\s+/g, ' ').trim(), 160)
  if (typeof error === 'object') {
    const message = error.message ?? error.error ?? error.reason
    if (typeof message === 'string' && message) {
      return truncate(message.replace(/\s+/g, ' ').trim(), 160)
    }
  }
  return truncate(String(error).replace(/\s+/g, ' ').trim(), 160)
}

/** One-line approval summary. */
function approvalText(request) {
  const tool = typeof request?.toolName === 'string' ? request.toolName : ''
  const reason =
    request?.displayReason?.zh ||
    request?.displayReason?.en ||
    (typeof request?.reason === 'string' ? request.reason : '')
  const detail = [tool, reason ? `(${reason})` : ''].filter(Boolean).join(' ')
  return truncate(detail, 160)
}

/** One-line user-question summary. */
function questionText(request) {
  const question = Array.isArray(request?.questions) ? request.questions[0] : undefined
  const text =
    question?.question ??
    question?.prompt ??
    question?.header ??
    question?.title ??
    (typeof question === 'string' ? question : '')
  return truncate(String(text || '').replace(/\s+/g, ' ').trim(), 160)
}

/** Escape one PowerShell single-quoted string literal. */
function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Build the PowerShell that shows one Windows toast. Payload text travels as
 * base64 so no quoting rule of the toast XML or PowerShell can reinterpret it.
 */
function toastScript(title, body, launch, appId, sound) {
  const encoded = (value) => Buffer.from(String(value), 'utf8').toString('base64')
  const silent = sound ? 'false' : 'true'
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(title)}'))`,
    `$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(body)}'))`,
    `$launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded(launch)}'))`,
    '$esc = [System.Security.SecurityElement]',
    `$xmlText = '<toast activationType="protocol" launch="' + $esc::Escape($launch) + '"><visual><binding template="ToastGeneric"><text>' + $esc::Escape($title) + '</text><text>' + $esc::Escape($body) + '</text></binding></visual><audio silent="${silent}" /></toast>'`,
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml($xmlText)',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psString(appId)}).Show($toast)`,
  ].join('\n')
}

/** Read one small JSON request body; resolves undefined on any failure. */
function readJson(req, limit = 8192) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        finish(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) {
        finish(undefined)
        return
      }
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    req.on('error', () => finish(undefined))
    req.on('close', () => finish(undefined))
  })
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  /** @type {Map<string, { res: import('node:http').ServerResponse, permission: string, visible: boolean, seenAt: number }>} */
  const clients = new Map()
  const running = new Set()
  const recentErrorAt = new Map()
  const recentNoticeAt = new Map()
  let spawnWarned = false
  let toastAppIdReady = false
  let toastAppIdPromise

  const origin = () => {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return ''
    }
  }

  /** Only loopback page origins may read the notification stream. */
  function trusted(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const host = String(req.headers.host || '').toLowerCase()
    const hostname = host.replace(/:\d+$/, '')
    const loopback =
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === '::1'
    if (!loopback) return false
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
    if (!requestOrigin) return true
    try {
      const parsed = new URL(requestOrigin)
      return (
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '::1' ||
        parsed.hostname === '[::1]'
      )
    } catch {
      return false
    }
  }

  function broadcast(notice) {
    if (config.browser.enabled === false) return
    const frame = `event: notification\ndata: ${JSON.stringify(notice)}\n\n`
    for (const client of clients.values()) {
      try {
        client.res.write(frame)
      } catch {
        // A dead socket is removed by its own close handler.
      }
    }
  }

  function browserChannelAvailable() {
    const now = Date.now()
    for (const client of clients.values()) {
      if (client.permission === 'granted' && now - client.seenAt < CLIENT_STALE_MS) return true
    }
    return false
  }

  /**
   * The single session a page is currently showing in a focused, visible window.
   * A user attends to one page and one session at a time, so a completion notice
   * for exactly this session is suppressed for every client; any other session
   * still notifies.
   */
  function attentionSessionId() {
    const now = Date.now()
    let winner
    for (const client of clients.values()) {
      if (!client.visible || !client.focused || !client.currentSessionId) continue
      if (now - client.seenAt >= CLIENT_STALE_MS) continue
      if (!winner || client.seenAt > winner.seenAt) winner = client
    }
    return winner ? winner.currentSessionId : undefined
  }

  function shouldToast(kind) {
    const mode = config.windowsToast.enabled
    if (mode === 'never') return false
    if (kind === 'test') return true
    if (mode === 'always') return true
    return !browserChannelAvailable()
  }

  /**
   * Register the toast sender under HKCU so Windows shows "DSH Web" instead of
   * the generic "Run" app name. The write is user-scoped and idempotent.
   */
  function toastAppIdScript(appId) {
    const key = `HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\${appId}`
    return [
      "$ErrorActionPreference = 'Stop'",
      `$key = ${psString(key)}`,
      'New-Item -Path $key -Force | Out-Null',
      `Set-ItemProperty -Path $key -Name DisplayName -Value ${psString('DSH Web')}`,
    ].join('\n')
  }

  function ensureToastAppId() {
    if (!config.windowsToast.appId || config.windowsToast.appId === 'Microsoft.Windows.Shell.RunDialog') {
      return Promise.resolve()
    }
    if (toastAppIdReady) return Promise.resolve()
    if (toastAppIdPromise) return toastAppIdPromise
    toastAppIdPromise = new Promise((resolve) => {
      const encoded = Buffer.from(
        toastAppIdScript(config.windowsToast.appId),
        'utf16le',
      ).toString('base64')
      let child
      try {
        child = spawn(
          config.windowsToast.command,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { stdio: 'ignore', windowsHide: true },
        )
      } catch (error) {
        warnSpawn(error)
        toastAppIdReady = true
        resolve()
        return
      }
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        toastAppIdReady = true
        resolve()
      }
      child.on('error', (error) => {
        warnSpawn(error)
        done()
      })
      child.on('exit', done)
      const timer = setTimeout(done, 5000)
      if (typeof timer.unref === 'function') timer.unref()
      child.unref()
    })
    return toastAppIdPromise
  }

  function raiseToast(notice) {
    void ensureToastAppId().then(() => spawnToast(notice))
  }

  function spawnToast(notice) {
    const title =
      notice.title && notice.title !== 'DSH' ? `DSH · ${notice.title}` : 'DSH'
    const body = notice.body || ''
    const base = origin() || 'http://127.0.0.1:3080'
    // A toast click opens the browser; carry the session so the new tab lands on
    // it. Only a page click can focus an already-open tab.
    const launch =
      config.windowsToast.launchUrl ||
      (notice.sessionId
        ? `${base}/?dsh-session=${encodeURIComponent(notice.sessionId)}`
        : `${base}/`)
    const script = toastScript(
      title,
      body,
      launch,
      config.windowsToast.appId,
      config.windowsToast.sound,
    )
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    let child
    try {
      child = spawn(
        config.windowsToast.command,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { stdio: 'ignore', windowsHide: true, detached: true },
      )
    } catch (error) {
      warnSpawn(error)
      return
    }
    child.on('error', warnSpawn)
    child.unref()
  }

  function warnSpawn(error) {
    if (spawnWarned) return
    spawnWarned = true
    console.warn(
      `[dsh-notifier] cannot raise a Windows toast through "${config.windowsToast.command}":`,
      error?.message || error,
    )
  }

  function sessionOf(sessionId, agent) {
    try {
      const subject = agent || (sessionId ? ctx.agents.get(sessionId) : undefined)
      return subject && subject.session ? subject.session : undefined
    } catch {
      return undefined
    }
  }

  function describeSession(sessionId, agent) {
    let title = ''
    let cwd = ''
    try {
      const session = sessionOf(sessionId, agent)
      if (session) {
        cwd = session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
        try {
          const titleService = ctx.get('sessionTitle')
          const snapshot = titleService ? titleService.get(session) : undefined
          title = snapshot && typeof snapshot.title === 'string' ? snapshot.title : ''
        } catch {
          title = ''
        }
      }
    } catch {
      title = ''
    }
    if (!title && cwd) title = basename(cwd)
    if (!title && sessionId) title = `会话 ${String(sessionId).slice(0, 8)}`
    return { title: truncate(title || 'DSH', 60), cwd }
  }

  function composeBody(kind, detail, info) {
    const where = info.cwd ? ` · ${basename(info.cwd)}` : ''
    switch (kind) {
      case 'completed':
        return `任务已完成${where}`
      case 'error':
        return `执行失败${detail ? `：${detail}` : ''}${where}`
      case 'approval':
        return `需要审批${detail ? `：${detail}` : ''}${where}`
      case 'question':
        return `需要你回答${detail ? `：${detail}` : ''}${where}`
      case 'test':
        return detail || '通知通道工作正常'
      default:
        return detail || ''
    }
  }

  function publish({ kind, sessionId, agent, detail, force = false }) {
    if (!config.includeSubagents && !force) {
      const session = sessionOf(sessionId, agent)
      if (session && session.header && session.header.origin === 'subagent') {
        return { suppressed: true, reason: 'subagent' }
      }
    }
    const attention = attentionSessionId()
    // A finished turn in the session a page already shows needs no alert. Events
    // that demand action (error, approval, question) still notify even for the
    // attended session.
    if (!force && kind === 'completed' && sessionId && attention && String(sessionId) === attention) {
      return { suppressed: true, reason: 'attention' }
    }
    const now = Date.now()
    const key = `${kind}:${sessionId || 'global'}`
    const last = recentNoticeAt.get(key) || 0
    if (!force && now - last < config.debounceMs) {
      return { suppressed: true, reason: 'debounce' }
    }
    recentNoticeAt.set(key, now)
    if (recentNoticeAt.size > MAX_SEEN) {
      for (const [entry, at] of recentNoticeAt) {
        if (now - at > 60_000) recentNoticeAt.delete(entry)
      }
    }
    const info = describeSession(sessionId, agent)
    const notice = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      sessionId: sessionId ? String(sessionId) : undefined,
      title: info.title,
      body: composeBody(kind, detail, info),
      ts: now,
      force: force === true,
      // The session every page should consider attended, so multi-page clients
      // agree on which completion is already visible.
      attentionSessionId: attention || undefined,
    }
    broadcast(notice)
    const toast = shouldToast(kind)
    if (toast) raiseToast(notice)
    return { suppressed: false, reason: undefined, toast, attention: attention || undefined }
  }

  function updateClientState(body) {
    if (!body || typeof body.client !== 'string') return
    const client = clients.get(body.client)
    if (!client) return
    const permission = body.permission
    if (permission === 'granted' || permission === 'denied' || permission === 'default') {
      client.permission = permission
    }
    client.visible = body.visible === true
    client.focused = body.focused === true
    client.currentSessionId =
      typeof body.currentSessionId === 'string' && body.currentSessionId
        ? body.currentSessionId
        : undefined
    client.seenAt = Date.now()
  }

  function openStream(req, res, url) {
    const clientId = url.searchParams.get('client') || `anon-${Math.random().toString(36).slice(2)}`
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    res.write(`event: hello\ndata: ${JSON.stringify({ clientId, ts: Date.now() })}\n\n`)
    const previous = clients.get(clientId)
    if (previous) {
      try {
        previous.res.end()
      } catch {
        // Already closed.
      }
    }
    clients.set(clientId, {
      res,
      permission: previous ? previous.permission : 'unknown',
      visible: previous ? previous.visible : false,
      focused: previous ? previous.focused : false,
      currentSessionId: previous ? previous.currentSessionId : undefined,
      seenAt: Date.now(),
    })
    const drop = () => {
      const current = clients.get(clientId)
      if (current && current.res === res) clients.delete(clientId)
    }
    req.on('close', drop)
    res.on('close', drop)
    res.on('error', drop)
  }

  async function handleRequest(req, res) {
    try {
      if (!trusted(req)) {
        res.statusCode = 403
        res.end('forbidden')
        return
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === `${ROUTE_PREFIX}/events` && req.method === 'GET') {
        openStream(req, res, url)
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/client-state` && req.method === 'POST') {
        const body = await readJson(req)
        updateClientState(body)
        res.writeHead(204).end()
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/test` && req.method === 'POST') {
        const body = await readJson(req)
        const kind =
          body && typeof body.kind === 'string' && NOTICE_KINDS.includes(body.kind)
            ? body.kind
            : 'test'
        const sessionId =
          body && typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined
        const outcome = publish({
          kind,
          sessionId,
          detail: kind === 'test' ? '通知通道工作正常' : '这是一条测试通知',
          force: kind === 'test',
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, ...outcome }))
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/state` && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({
            clients: clients.size,
            browserChannel: browserChannelAvailable(),
            toast: config.windowsToast.enabled,
            running: running.size,
            recent: recentNoticeAt.size,
            watching: [...clients.values()]
              .filter((client) => client.visible && client.focused && client.currentSessionId)
              .map((client) => client.currentSessionId),
            clientsDetail: [...clients.values()].map((client) => ({
              permission: client.permission,
              visible: client.visible,
              focused: client.focused,
              current: client.currentSessionId,
              ageMs: Date.now() - client.seenAt,
            })),
          }),
        )
        return
      }
      res.statusCode = 404
      res.end('not found')
    } catch {
      try {
        res.statusCode = 500
        res.end('notifier error')
      } catch {
        // The response is already gone.
      }
    }
  }

  // Agents already running when this plugin loads still get a completion notice.
  try {
    if (ctx.agents && typeof ctx.agents.list === 'function') {
      for (const agent of ctx.agents.list()) {
        if (!agent || agent.id == null || agent.status !== 'running') continue
        const session = agent.session
        if (
          !config.includeSubagents &&
          session &&
          session.header &&
          session.header.origin === 'subagent'
        ) {
          continue
        }
        running.add(String(agent.id))
      }
    }
  } catch {
    // Derived cache only; a failure to seed it never blocks notifications.
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        void handleRequest(req, res)
      },
    })
    const heartbeat = setInterval(() => {
      for (const client of clients.values()) {
        try {
          client.res.write(': ping\n\n')
        } catch {
          // Ignored: the close handler owns removal.
        }
      }
    }, HEARTBEAT_MS)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
    return () => {
      clearInterval(heartbeat)
      disposeRoute()
      for (const client of clients.values()) {
        try {
          client.res.end()
        } catch {
          // Already closed.
        }
      }
      clients.clear()
    }
  }, 'dsh-notifier: sse channel')

  ctx.on('agent/status', (payload) => {
    if (!config.events.completed) return
    const agent = payload?.agent
    if (!agent || agent.id == null) return
    const sessionId = String(agent.id)
    if (payload.status === 'running') {
      running.add(sessionId)
      return
    }
    if (payload.status !== 'idle') return
    if (!running.delete(sessionId)) return
    const erroredAt = recentErrorAt.get(sessionId) || 0
    if (Date.now() - erroredAt < RECENT_ERROR_MS) return
    publish({ kind: 'completed', sessionId, agent })
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (!agent || agent.id == null) return
    const sessionId = String(agent.id)
    running.delete(sessionId)
    recentErrorAt.delete(sessionId)
  })

  ctx.on('agent/error', (payload) => {
    if (!config.events.error) return
    const agent = payload?.agent
    if (!agent || agent.id == null) return
    const sessionId = String(agent.id)
    recentErrorAt.set(sessionId, Date.now())
    if (recentErrorAt.size > MAX_SEEN) recentErrorAt.clear()
    publish({ kind: 'error', sessionId, agent, detail: errorText(payload.error) })
  })

  ctx.on('approval/request', async (request, next) => {
    try {
      if (config.events.approval && request) {
        const agent = request.agent
        publish({
          kind: 'approval',
          sessionId: agent && agent.id != null ? String(agent.id) : undefined,
          agent,
          detail: approvalText(request),
        })
      }
    } catch {
      // A notification failure must never affect approval dispatch.
    }
    return next()
  })

  ctx.on('user-questions/request', async (request, next) => {
    try {
      if (config.events.question && request) {
        const agent = request.agent
        publish({
          kind: 'question',
          sessionId: agent && agent.id != null ? String(agent.id) : undefined,
          agent,
          detail: questionText(request),
        })
      }
    } catch {
      // A notification failure must never affect question dispatch.
    }
    return next()
  })
}
