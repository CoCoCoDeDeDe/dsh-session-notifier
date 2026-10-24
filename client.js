/**
 * DSH desktop notifier — Client half.
 *
 * Keeps one SSE channel to the Host half, raises browser notifications for
 * session events, and contributes a General-settings row that manages the
 * browser Notification permission.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useReducer, useEffect } = React

    const NS = 'dsh-notifier'
    const CLIENT_ID_KEY = 'dsh-notifier-client'

    const zh = {
      'settings.title': '桌面通知',
      'settings.description.granted':
        '浏览器通知已启用。会话完成、执行失败、需要审批或需要你回答时会提醒你。',
      'settings.description.default':
        '启用后，会话完成、执行失败、需要审批或需要你回答时会在系统里通知你。',
      'settings.description.denied':
        '浏览器已阻止通知。请在地址栏的站点设置中允许通知，然后刷新页面。',
      'settings.description.unsupported': '当前浏览器不支持桌面通知。',
      'settings.enable': '启用通知',
      'settings.test': '发送测试通知',
      'notify.testTitle': 'DSH 通知测试',
      'notify.testBody': '通知通道工作正常。',
    }

    const en = {
      'settings.title': 'Desktop notifications',
      'settings.description.granted':
        'Browser notifications are on. You are alerted when a session finishes, fails, needs an approval, or asks you a question.',
      'settings.description.default':
        'Enable notifications to be alerted when a session finishes, fails, needs an approval, or asks you a question.',
      'settings.description.denied':
        'Notifications are blocked. Allow them in the site settings of the address bar, then reload the page.',
      'settings.description.unsupported': 'This browser does not support desktop notifications.',
      'settings.enable': 'Enable notifications',
      'settings.test': 'Send test notification',
      'notify.testTitle': 'DSH notification test',
      'notify.testBody': 'The notification channel works.',
    }

    const rowCss = `
.dsh-notifier-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dsh-notifier-text{min-width:0}
.dsh-notifier-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dsh-notifier-description{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-notifier-action{flex:none;font-family:inherit;font-size:13px;line-height:18px;padding:6px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-brand-primary);background:transparent;cursor:pointer}
.dsh-notifier-action:hover{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent)}
`

    let cachedClientId
    const state = {
      ctx: null,
      t: (key) => key,
      channelOpen: false,
      currentSessionId: undefined,
      listeners: new Set(),
    }

    function clientId() {
      if (cachedClientId) return cachedClientId
      try {
        let value = window.sessionStorage.getItem(CLIENT_ID_KEY)
        if (!value) {
          value =
            typeof crypto !== 'undefined' && crypto.randomUUID
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`
          window.sessionStorage.setItem(CLIENT_ID_KEY, value)
        }
        cachedClientId = value
      } catch {
        cachedClientId = `anon-${Math.random().toString(36).slice(2)}`
      }
      return cachedClientId
    }

    function permission() {
      try {
        if (typeof Notification === 'undefined') return 'unsupported'
        return Notification.permission
      } catch {
        return 'unsupported'
      }
    }

    function bump() {
      for (const listener of state.listeners) {
        try {
          listener()
        } catch {
          // A stale component must not break notification delivery.
        }
      }
    }

    function postJson(path, body) {
      return fetch(new URL(path, window.location.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => undefined)
    }

    function reportState() {
      const body = {
        client: clientId(),
        permission: permission(),
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        currentSessionId: state.currentSessionId,
      }
      void postJson('/dsh-notifier/client-state', body)
    }

    function showNotification(notice, force) {
      if (typeof Notification === 'undefined') return
      if (Notification.permission !== 'granted') return
      const focused = document.visibilityState === 'visible' && document.hasFocus()
      // `attentionSessionId` is the session the Host believes one focused page is
      // showing; using it keeps several open pages consistent. Local state backs
      // it up when a notice raced ahead of the latest report.
      const attention = notice.attentionSessionId || state.currentSessionId
      const attended = Boolean(notice.sessionId && attention && notice.sessionId === attention)
      // Only a finished turn in the attended session is silent; errors and
      // questions deserve an alert even while the session is on screen.
      if (!force && notice.kind === 'completed' && focused && attended) return
      try {
        const notification = new Notification(notice.title || 'DSH', {
          body: notice.body || '',
          tag: `dsh-notifier-${notice.kind}-${notice.sessionId || 'global'}`,
          requireInteraction: notice.kind === 'approval' || notice.kind === 'question',
        })
        notification.onclick = () => {
          try {
            window.focus()
          } catch {
            // Some browsers ignore focus requests.
          }
          if (notice.sessionId && state.ctx && state.ctx.uiWorkspace) {
            try {
              state.ctx.uiWorkspace.openSession(notice.sessionId)
            } catch {
              // Opening a pruned session is best effort.
            }
          }
          try {
            notification.close()
          } catch {
            // Already dismissed.
          }
        }
      } catch {
        // A browser may throw for background pages; there is nothing to recover.
      }
    }

    async function requestPermission() {
      if (typeof Notification === 'undefined') return 'unsupported'
      let result = Notification.permission
      try {
        result = await Notification.requestPermission()
      } catch {
        result = permission()
      }
      bump()
      reportState()
      return result
    }

    async function sendTest() {
      if (permission() === 'default') await requestPermission()
      if (permission() !== 'granted') return
      const posted = await postJson('/dsh-notifier/test', {})
      if (!posted) {
        // The Host could not be reached; still prove the browser channel works.
        showNotification(
          {
            kind: 'test',
            title: state.t('notify.testTitle'),
            body: state.t('notify.testBody'),
          },
          true,
        )
      }
    }

    function startChannel() {
      let source
      try {
        const url = new URL('/dsh-notifier/events', window.location.origin)
        url.searchParams.set('client', clientId())
        source = new EventSource(url)
      } catch {
        return () => {}
      }
      const onHello = () => {
        state.channelOpen = true
        reportState()
      }
      const onError = () => {
        state.channelOpen = false
      }
      const onNotification = (event) => {
        let notice
        try {
          notice = JSON.parse(event.data)
        } catch {
          return
        }
        if (!notice || typeof notice !== 'object') return
        showNotification(notice, notice.force === true)
      }
      source.addEventListener('hello', onHello)
      source.addEventListener('error', onError)
      source.addEventListener('notification', onNotification)
      reportState()
      return () => {
        source.removeEventListener('hello', onHello)
        source.removeEventListener('error', onError)
        source.removeEventListener('notification', onNotification)
        try {
          source.close()
        } catch {
          // Already closed.
        }
      }
    }

    /**
     * Invisible probe rendered by the resident composer of the session the user
     * is looking at. Its `sessionId` prop is the stable render-time source of
     * "current session" for a Client plugin.
     */
    function CurrentSessionProbe(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : undefined
      useEffect(() => {
        state.currentSessionId = sessionId
        reportState()
        return () => {
          if (state.currentSessionId === sessionId) {
            state.currentSessionId = undefined
            reportState()
          }
        }
      }, [sessionId])
      return null
    }

    function NotifierSettingsRow() {
      const [, force] = useReducer((value) => value + 1, 0)
      useEffect(() => {
        state.listeners.add(force)
        const unsubscribe = state.ctx ? state.ctx.locale.subscribe(() => force()) : () => {}
        return () => {
          state.listeners.delete(force)
          unsubscribe()
        }
      }, [])
      const current = permission()
      const description = state.t(`settings.description.${current}`)
      const action =
        current === 'granted'
          ? { label: state.t('settings.test'), onClick: () => void sendTest() }
          : current === 'default'
            ? { label: state.t('settings.enable'), onClick: () => void requestPermission() }
            : undefined
      return h(
        'div',
        { className: 'dsh-notifier-row' },
        h('style', null, rowCss),
        h(
          'div',
          { className: 'dsh-notifier-text' },
          h('div', { className: 'dsh-notifier-title' }, state.t('settings.title')),
          h('div', { className: 'dsh-notifier-description' }, description),
        ),
        action
          ? h(
              'button',
              { type: 'button', className: 'dsh-notifier-action', onClick: action.onClick },
              action.label,
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        state.ctx = ctx
        state.t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-notifier: dictionaries')
        ctx.effect(() => startChannel(), 'dsh-notifier: sse channel')

        ctx.effect(() => {
          const onVisibility = () => reportState()
          document.addEventListener('visibilitychange', onVisibility)
          window.addEventListener('focus', onVisibility)
          return () => {
            document.removeEventListener('visibilitychange', onVisibility)
            window.removeEventListener('focus', onVisibility)
          }
        }, 'dsh-notifier: visibility reporting')

        ctx.effect(() => {
          const timer = window.setInterval(reportState, 60_000)
          return () => window.clearInterval(timer)
        }, 'dsh-notifier: state heartbeat')

        ctx.effect(() => {
          const gesture = () => {
            if (permission() === 'default') void requestPermission()
          }
          document.addEventListener('pointerdown', gesture, { once: true, capture: true })
          return () => document.removeEventListener('pointerdown', gesture, { capture: true })
        }, 'dsh-notifier: first-gesture permission')

        ctx.effect(() => {
          if (typeof navigator === 'undefined' || !navigator.permissions) return () => {}
          let status
          let cancelled = false
          navigator.permissions
            .query({ name: 'notifications' })
            .then((value) => {
              if (cancelled) return
              status = value
              value.onchange = () => {
                bump()
                reportState()
              }
            })
            .catch(() => {})
          return () => {
            cancelled = true
            if (status) status.onchange = null
          }
        }, 'dsh-notifier: permission tracking')

        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'dsh-notifier',
              order: 25,
            },
            NotifierSettingsRow,
          ),
        )

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'dsh-notifier-probe',
              order: 1000,
            },
            CurrentSessionProbe,
          ),
        )
      },
    }
  },
})
