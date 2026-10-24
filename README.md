# dsh-session-notifier

[![npm version](https://img.shields.io/npm/v/dsh-session-notifier.svg)](https://www.npmjs.com/package/dsh-session-notifier)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）Web 会话加桌面通知：**会话完成、执行失败、需要审批、需要你回答**时提醒你。

- **浏览器通知**：页面开着时由客户端弹出；点击后定位到对应会话——已有标签页打开该会话就聚焦它（不刷新），没有才新开一个标签页。
- **Windows Toast**：在 WSL/Windows 下由 Host 直接调用 `powershell.exe` 弹出，页面关掉也能收到；点击会新开一个浏览器标签页并定位到对应会话（平台限制：无法聚焦已打开的标签页）。

点击后的完整行为见[点击通知的行为](#点击通知的行为)。

English: desktop notifications for DSH Web sessions — browser notifications plus Windows toasts from WSL; clicking a notification opens its session.

## 安装

```bash
dsh plugin --profile web add dsh-session-notifier
```

然后：

1. 重启 `dsh web`（profile 的 bundle 列表只在启动时读取）；
2. 浏览器**硬刷新**（`Ctrl+Shift+R`）；
3. 首次点击 DSH 页面任意位置，允许浏览器通知权限。

也可以在 **设置 → 通用 → 桌面通知** 中查看权限状态、启用通知或发送测试通知。

从源码安装（本地开发）：

```bash
cd /path/to/dsh-session-notifier
dsh plugin --profile web add "link:$PWD"
```

## 触发事件

| 事件 | 来源 | 通知内容 |
| --- | --- | --- |
| 回合完成 | `agent/status` 从 `running` 变为 `idle` | `任务已完成 · <目录>` |
| 执行失败 | `agent/error` | `执行失败：<错误> · <目录>` |
| 需要审批 | `approval/request` | `需要审批：<工具>（<原因>） · <目录>` |
| 需要回答 | `user-questions/request` | `需要你回答：<问题> · <目录>` |

通知标题使用会话标题（`sessionTitle` 投影），无标题时回退到工作目录名或会话 id 前 8 位。子代理会话默认不通知。

## 通道与关注会话

客户端通过 SSE（`/dsh-notifier/events`）接收通知，并上报浏览器通知权限与当前正在浏览的会话。Host 的
`windowsToast.enabled` 决定是否同时弹 Windows Toast：

- `auto`（默认）：有页面已授予通知权限时只发浏览器通知，避免重复；没有可用页面时回退到 Windows Toast。关闭浏览器通道（`browser.enabled: false`）时视同 `always`，只弹 Toast。
- `always`：每条未被关注会话抑制的通知同时弹 Windows Toast，最可靠，但会与浏览器通知重复。
- `never`：从不弹 Toast。

**被关注会话**：同时只看一个页面、一个会话。聚焦且可见的页面上报的当前会话即被关注会话。

- 被关注会话的**完成**通知会被抑制（页面本身已经能看到结果），且对所有页面一致抑制。
- 其他会话的完成——同一页面的其他会话、其他标签页/窗口的会话——都会通知。
- 失败、审批、提问即使发生在被关注会话也会通知（这些需要行动）。
- 页面失焦、最小化或关闭时，所有完成都会通知；没有页面连接时由 Windows Toast 接管。

## 环境要求

| 要求 | 说明 |
| --- | --- |
| DSH | `>=0.2.1-rc.2 <0.3.0-0` |
| Node.js | `>=20` |
| 浏览器 | Chrome / Edge（通知授权依赖用户手势） |
| Windows Toast | Windows 或 WSL，PATH 中有 `powershell.exe`；其他平台只用浏览器通知 |

## 配置

默认配置在包内的 `cordis.patch.yml`。要覆盖，在本 profile 的用户 patch 层
（`~/.dsh/profiles/web/cordis.patch.yml`）加一条同 id 的配置；匹配的覆盖会替换整个 `config`：

```yaml
- id: dsh-notifier
  name: dsh-session-notifier
  config:
    events:
      completed: true
      error: true
      approval: true
      question: true
    windowsToast:
      enabled: auto          # auto | always | never（也接受 true/false）
      sound: true
      appId: DSH.Web
      # launchUrl: http://127.0.0.1:3080/
    browser:
      enabled: true
    # 额外允许访问通知路由的主机名（反向代理场景）；绑定地址与本机地址始终放行
    allowedHosts: []
    debounceMs: 4000
    includeSubagents: false   # true 时子代理/子会话也通知
```

改完后由 HMR 重载配置；如果没生效，刷新页面或重启 DSH。

## 验证

```bash
# 通道状态（客户端数、浏览器通道是否可用、Toast 模式、被关注会话）
curl -s http://127.0.0.1:3080/dsh-notifier/state

# 发送一条测试通知：浏览器通知 + Windows Toast
curl -s -X POST http://127.0.0.1:3080/dsh-notifier/test -H 'content-type: application/json' -d '{}'

# 模拟某个会话的事件（用于验证关注会话抑制）
curl -s -X POST http://127.0.0.1:3080/dsh-notifier/test \
  -H 'content-type: application/json' \
  -d '{"kind":"completed","sessionId":"session-other"}'
# kind 可为 completed / error / approval / question / test

# 观察 SSE 广播
curl -sN 'http://127.0.0.1:3080/dsh-notifier/events?client=probe'
```

## 点击通知的行为

| 场景 | 点击后 |
| --- | --- |
| 浏览器通知，已有标签页打开该会话 | 聚焦该标签页，不刷新、不重新加载 |
| 浏览器通知，没有标签页打开该会话 | 新开标签页并以 `?dsh-session=<id>` 定位到该会话 |
| 浏览器通知，当前页就是该会话 | 聚焦当前页 |
| 浏览器通知，没有会话 id（全局通知） | 只聚焦当前页 |
| Windows Toast | 新开标签页并定位到对应会话；无法聚焦已打开的标签页 |
| 目标会话已删除或无法打开 | 停留在当前视图（新标签页打开 DSH 首页） |

新标签页定位完成后会把 `dsh-session` 参数从地址栏移除，之后刷新不会重复跳转。Toast 的打开地址可以用配置里的 `windowsToast.launchUrl` 覆盖。

## 已知限制

- **需要浏览器进程在运行才能收到浏览器通知**；页面全部关掉后由 Windows Toast 接管（仅 Windows/WSL）。
- 通知路由只接受本机（`127.0.0.1` / `localhost` / `::1`）、`dsh web` 实际绑定的地址，以及 `allowedHosts` 里显式列出的主机；经 `--public-url` 反向代理访问时，要把代理域名加入 `allowedHosts`。路由没有额外鉴权，不要把端点暴露到不受信任的网络。
- Windows Toast 使用 `DSH.Web` 作为 AppID，插件首次发送时会在 `HKCU\SOFTWARE\Classes\AppUserModelId\DSH.Web` 写入显示名 `DSH Web`（用户级注册表，幂等，不需要管理员权限）。想换名称可改配置里的 `appId`。
- Toast 点击会新开一个浏览器标签页并直接定位到对应会话（`?dsh-session=<id>`）。Windows 协议激活无法聚焦已经打开的标签页，这是平台限制；浏览器通知的点击则优先聚焦已有标签页。
- 审批/提问通知依赖 Host 的 `approval/request`、`user-questions/request` 事件；在审批策略为 `never` 时不会触发审批通知。
- 子代理会话默认被过滤，主会话完成时会统一通知。

## License

[MIT](LICENSE)
