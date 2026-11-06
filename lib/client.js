/**
 * 浏览器半侧：设置 → 通用 里的「人设」开关。
 *
 * 这个文件是**手写的客户端 bundle**，不需要构建步骤：
 * 外壳（dsh-client-modules）按 `dsh.client` 声明加载它，格式就是
 * `window.__ModuleLoader__.load({ id, factory })`，factory 收到 `require`
 * 后在导出上暴露 `apply` / `inject`，与第一方客户端插件完全一致。
 *
 * 开关本身不改任何配置：它 POST 到宿主侧的 `/api/dsh-lm-bridge/toggle`，
 * 由宿主进程内的一个布尔位决定「人设 + 记忆注入」是否生效，重启后回到配置默认。
 */

window.__ModuleLoader__.load({
  id: 'dsh-lm-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const API = '/api/dsh-lm-bridge'

    const boxStyle = {
      alignItems: 'center',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      borderRadius: 'var(--dsw-radius-l, 10px)',
      display: 'flex',
      gap: '10px',
      justifyContent: 'space-between',
      padding: '12px 0'
    }
    const textStyle = {
      color: 'var(--dsw-alias-label-primary)',
      display: 'flex',
      flexDirection: 'column',
      fontSize: '14px',
      gap: '2px',
      lineHeight: '22px'
    }
    const hintStyle = { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '12px' }
    const buttonStyle = {
      background: 'var(--dsw-alias-bg-module-platform, transparent)',
      border: '0.5px solid var(--dsw-alias-border-l4, #ccc)',
      borderRadius: '999px',
      cursor: 'pointer',
      fontSize: '13px',
      minWidth: '86px',
      padding: '6px 14px'
    }

    /** 一颗开关：点击即切换，失败保持原状态并提示。 */
    function PersonaToggle() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        let alive = true
        fetch(`${API}/state`)
          .then((response) => response.json())
          .then((json) => {
            if (alive) setState(json)
          })
          .catch(() => {
            if (alive) setError('读不到宿主状态')
          })
        return () => {
          alive = false
        }
      }, [])

      const flip = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const response = await fetch(`${API}/toggle`, { method: 'POST' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setState(await response.json())
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [])

      const on = state === null ? null : state.enabled !== false
      const label = on === null ? '读取中…' : on ? '人设：开' : '人设：关'
      const hint =
        error.length > 0
          ? `切换失败：${error}`
          : on === null
            ? '正在读取宿主状态'
            : on
              ? '角色人格与长期记忆会注入每一轮'
              : '只走工程 agent，不注入人格与记忆'

      return h(
        'div',
        { style: boxStyle },
        h(
          'div',
          { style: textStyle },
          h('span', null, '角色人设（AstrBot）'),
          h('span', { style: hintStyle }, hint)
        ),
        h(
          'button',
          {
            type: 'button',
            style: buttonStyle,
            disabled: busy || on === null,
            onClick: flip,
            title: '切换人设与记忆注入（仅本进程生效）'
          },
          busy ? '切换中…' : label
        )
      )
    }

    function apply(ctx) {
      // settings.general.item 是第一方设置页「通用」里的一行，槽位稳定。
      // 槽位不存在时只丢这一行，绝不让整个客户端插件挂掉。
      try {
        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            { name: 'settings.general.item', id: 'lm-bridge-persona-toggle', order: 90 },
            PersonaToggle
          )
        )
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('dsh-lm-bridge: 设置行注册失败（开关不可见，插件其余功能不受影响）', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.PersonaToggle = PersonaToggle
    return module.exports
  }
})
