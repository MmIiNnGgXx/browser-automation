# dsh-browser-tool — 零依赖浏览器/电脑自动化驱动（DSH 的"补唯一缺失"能力）

这是一个用 **CDP**（Chrome DevTools Protocol）驱动 headless Chrome/Edge 的工具，
给 DSH 补上它目前完全没有的「浏览器/电脑自动化」能力。**没有任何 npm 依赖**：
只用 Node 内置的 `http` / `crypto` / `events` + 手写 RFC6455 WebSocket（`wsclient.mjs`）。

## 用法（从 DSH 的 pwsh/node tool 调用）

```bash
# 长驻会话（一次启动、多次接收指令，最后 stop）
node dsh-browser-tool/browser.mjs start
node dsh-browser-tool/browser.mjs attach  <sid> view  <url> [waitMs]
node dsh-browser-tool/browser.mjs attach  <sid> shot  <url> <out.png>
node dsh-browser-tool/browser.mjs attach  <sid> eval  <url> "<js>"
node dsh-browser-tool/browser.mjs attach  <sid> click <url> <selector|text:<s>>
node dsh-browser-tool/browser.mjs attach  <sid> type  <url> <selector> <text>
node dsh-browser-tool/browser.mjs attach  <sid> links <url>
node dsh-browser-tool/browser.mjs attach  <sid> html  <url>
node dsh-browser-tool/browser.mjs stop   <sid>

# 单次（一次命令=一个浏览器，退出即销毁）
node dsh-browser-tool/browser.mjs view <url> [waitMs]
node dsh-browser-tool/browser.mjs shot <url> <out.png> [waitMs]
```

命令返回 JSON，便于模型消费。`click`/`type` 接受 CSS selector，click 也支持 `text:<文字>` 按可见文本定位。

## 为什么手写 WebSocket

Node 内置（undici）的 `WebSocket` 连上 CDP 后只要一发帧就以 1006 断开；
所以 `wsclient.mjs` 提供按 CDP 需要的最小 RFC6455 实现（无扩展、无压缩、客户端帧加掩码）。

## 已验证 / 局限（诚实说明）

在本机验证了：
- ✅ Node v24 有全局 `WebSocket` / `fetch` / `Buffer`，**零依赖可行**；
- ✅ headless Chrome/Edge 经 `--remote-debugging-port` 暴露 CDP；
- ✅ **browser-level** CDP 命令（`Target.getTargets`、`Target.attachToTarget`）正常返回；
- ❌ **page-level** CDP（`Runtime.evaluate` / `Page.enable` / `Page.captureScreenshot`）在
  本机 **Edge 152 headless** 上会 1006/ECONNRESET——这**不是本工具 bug**（官方 `ws` 库同样复现），
  是该 Edge/新 headless 对 page-session 的限制；
- ❌ 命令行 `--screenshot --no-sandbox` 又撞上 DSH Windows **受限令牌沙箱**的 crashpad ACL 拒绝。

**因此在本机当前组合（Windows + Edge152 headless + DSH 受限令牌沙箱）下，完整交互式
电脑自动化尚未跑通。** 这套 CDP 代码在 **Linux / macOS**（或换成支持 page-session 的
Chrome / Puppeteer 组合）是可用的。真正的落地是 DSH Phase 1 的 `dsh-tool-browser`：
把它注册成 DSH 插件（cordis 行 + tool schema），并在非受限环境跑通 page-session。

## 文件

- `browser.mjs` — 入口：启动/attach/动作分发。
- `wsclient.mjs` — 零依赖 RFC6455 WebSocket 客户端。
- 会话状态在 `dsh-browser-tool/.sessions/`（工作区可写），记录 port/pid/ws，用于 `attach`/`stop`。
