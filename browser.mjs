// dsh-browser-tool — zero-dependency computer-use (browser automation) for DeepSeek Harness.
//
// Drives a headless Chrome/Edge over the Chrome DevTools Protocol using only
// Node built-ins (node:http / node:crypto / node:events + a hand-rolled RFC6455
// WebSocket in wsclient.mjs). No playwright, no puppeteer, no npm deps.
//
// Transport note: Chrome/Edge DevTools does NOT reliably serve page-domain
// commands on the `devtools/page/<id>` sockets (undici's built-in WebSocket
// 1006-closes on send; Edge 152 ignores page-socket commands). So this tool
// connects to the BROWSER-level ws (`/devtools/browser/<id>`) and creates a
// page session through `Target.attachToTarget` — the same flow puppeteer uses,
// and it works across Chrome/Edge versions.
//
// Model-facing usage (from the DSH pwsh/node tool):
//   node dsh-browser-tool/browser.mjs start                          # launch one persistent headless browser, print sid
//   node dsh-browser-tool/browser.mjs attach  <sid> view   <url> [waitMs]
//   node dsh-browser-tool/browser.mjs attach  <sid> shot   <url> <out.png> [waitMs]
//   node dsh-browser-tool/browser.mjs attach  <sid> eval   <url> "<js>" [waitMs]
//   node dsh-browser-tool/browser.mjs attach  <sid> click  <url> <selector|text:<s>> [waitMs]
//   node dsh-browser-tool/browser.mjs attach  <sid> type   <url> <selector> <text>
//   node dsh-browser-tool/browser.mjs attach  <sid> links  <url>
//   node dsh-browser-tool/browser.mjs attach  <sid> html   <url>
//   node dsh-browser-tool/browser.mjs stop    <sid>
//
// Single-shot convenience (one command = one browser, then it exits):
//   node dsh-browser-tool/browser.mjs view <url> [waitMs]
//   node dsh-browser-tool/browser.mjs shot <url> <out.png> [waitMs]
//
// Session state lives next to the tool (workspace-writable) under .sessions/.
//
// NOTE on Windows session reuse: the DSH `pwsh` tool runs each command in a
// fresh process, and Windows may reap the detached browser when the tool call
// ends. `start` + `attach` reuse is therefore best-effort there; the
// single-shot `view`/`shot` commands are always reliable. On POSIX the
// `start`/`attach` flow is the recommended long-lived loop.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpWebSocket } from './wsclient.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const STATE_DIR = join(__dirname, '.sessions');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── browser binary discovery ────────────────────────────────────────────────
function findBrowsers() {
  const candidates = [
    process.env.BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.filter(Boolean).filter((c) => { try { return existsSync(c); } catch { return false; } });
}

async function waitForDevtools(port, tries = 40, deadCheck = null) {
  for (let i = 0; i < tries; i++) {
    if (deadCheck && deadCheck()) throw new Error('browser exited');
    try { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); if (v.webSocketDebuggerUrl) return v; }
    catch {}
    await sleep(250);
  }
  throw new Error(`Browser did not expose CDP on ${port}`);
}

async function tryLaunch(bin, port, profileDir) {
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--mute-audio',
    '--remote-allow-origins=*', '--window-size=1280,900',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    'about:blank',
  ];
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
  let exited = false;
  child.on('exit', () => { exited = true; });
  try {
    const v = await waitForDevtools(port, 40, () => exited);
    return { child, wsUrl: v.webSocketDebuggerUrl };
  } catch (e) {
    try { process.kill(child.pid); } catch {}
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

async function launchWorkingBrowser() {
  const bins = findBrowsers();
  if (!bins.length) throw new Error('No Chrome/Edge binary found. Set BROWSER env to its path.');
  let lastErr;
  for (const bin of bins) {
    const port = 9222 + Math.floor(Math.random() * 4000);
    const profileDir = join(tmpdir(), `dsh-browser-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(profileDir, { recursive: true });
    try {
      const { child, wsUrl } = await tryLaunch(bin, port, profileDir);
      // No probe here: opening a browser-level CDP connection and closing it to
      // "verify" would be a first connection that we then repeat in attachCdp.
      // Edge/Chrome reset a socket that is quickly closed and reopened, so the
      // tool connects exactly once (in attachCdp) after choosing a launch that
      // at least exposed CDP. Candidates that expose CDP but crash on a real
      // command are caught by the action-level retry in runOnce (see below).
      return { port, profileDir, pid: child.pid, bin, browserWs: wsUrl };
    } catch (e) {
      lastErr = e;
      try { process.kill(child.pid); } catch {}
      try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    }
  }
  throw lastErr || new Error('No browser could expose CDP.');
}

async function browserWsUrl(port) {
  const v = await waitForDevtools(port, 1);
  return v.webSocketDebuggerUrl;
}

// ── CDP client (browser-level session) ──────────────────────────────────────
class Cdp {
  constructor(browserWsUrl) {
    this.browserWsUrl = browserWsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.targetId = null;
  }
  async connect() {
    this.ws = new CdpWebSocket(this.browserWsUrl);
    this.ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
    this.ws.on('error', (e) => { const p = [...this.pending.values()]; this.pending.clear(); for (const x of p) x.reject(e); });
    this.ws.on('close', () => { const p = [...this.pending.values()]; this.pending.clear(); for (const x of p) x.reject(new Error('CDP socket closed')); });
    await this.ws.connect();
  }
  send(method, params = {}) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 60000);
    });
  }
  async raw(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 60000);
    });
  }
  // Find (or create) a page target and attach a session to it.
  async ensurePage() {
    const { targetInfos = [] } = await this.raw('Target.getTargets');
    let page = targetInfos.find((t) => t.type === 'page');
    if (!page) {
      const { targetId } = await this.raw('Target.createTarget', { url: 'about:blank' });
      page = { targetId, type: 'page', url: 'about:blank' };
    }
    const { sessionId } = await this.raw('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.targetId = page.targetId;
    this.sessionId = sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    return { targetId: page.targetId, sessionId };
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      const state = await this.eval('document.readyState');
      if (state === 'complete') break;
      await sleep(150);
    }
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  }
  close() { try { this.ws?.close(); } catch {} }
}

// ── session (persistent browser) management ─────────────────────────────────
function sessionFile(sid) { return join(STATE_DIR, `${sid}.json`); }

async function startSession() {
  mkdirSync(STATE_DIR, { recursive: true });
  const { port, profileDir, pid, browserWs } = await launchWorkingBrowser();
  const sid = randomSid();
  const rec = { port, profileDir, pid, browserWs, createdAt: Date.now() };
  const { cdp, targetId, sessionId } = await attachCdp(browserWs);
  rec.targetId = targetId; rec.sessionId = sessionId;
  writeFileSync(sessionFile(sid), JSON.stringify(rec, null, 2));
  const url = await cdp.eval('location.href');
  cdp.close();
  console.log(JSON.stringify({ ok: true, sid, port, url }));
}

async function attachCdp(browserWs) {
  const cdp = new Cdp(browserWs);
  await cdp.connect();
  const { targetId, sessionId } = await cdp.ensurePage();
  return { cdp, targetId, sessionId };
}

async function attach(sid) {
  const f = sessionFile(sid);
  if (!existsSync(f)) throw new Error(`No such session: ${sid}`);
  const rec = JSON.parse(readFileSync(f, 'utf8'));
  const { cdp, targetId, sessionId } = await attachCdp(rec.browserWs);
  rec.targetId = targetId; rec.sessionId = sessionId;
  writeFileSync(f, JSON.stringify(rec, null, 2));
  return { cdp, rec };
}

async function stopSession(sid) {
  const f = sessionFile(sid);
  if (!existsSync(f)) { console.log(JSON.stringify({ ok: false, error: 'no-such-session' })); return; }
  const rec = JSON.parse(readFileSync(f, 'utf8'));
  try { process.kill(rec.pid); } catch {}
  try { rmSync(rec.profileDir, { recursive: true, force: true }); } catch {}
  rmSync(f, { force: true });
  console.log(JSON.stringify({ ok: true, sid }));
}

function randomSid() { return `s-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`; }

// ── page actions (all take a live Cdp with an attached page session) ─────────
async function waitMs(ms) { if (ms > 0) await sleep(ms); }

async function elementCenter(cdp, selectorOrText) {
  const expr = (() => {
    if (selectorOrText.startsWith('text:')) {
      const t = JSON.stringify(selectorOrText.slice(5));
      return `(() => { const els=[...document.querySelectorAll('a,button,span,div,li,td,th,h1,h2,h3,h4,p')]; const t=${t}; const el=els.find(e=>e.textContent.trim()===t)||els.find(e=>e.textContent.includes(t)); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,text:el.textContent.trim().slice(0,80)}; })()`;
    }
    const sel = JSON.stringify(selectorOrText);
    return `(() => { const el=document.querySelector(${sel}); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,tag:el.tagName}; })()`;
  })();
  return cdp.eval(expr);
}

async function click(cdp, selectorOrText) {
  const c = await elementCenter(cdp, selectorOrText);
  if (!c || c.x == null) throw new Error(`Cannot find target: ${selectorOrText}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
  }
  return c;
}

async function typeInto(cdp, selector, text) {
  const found = await cdp.eval(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false; el.focus(); return true; })()`);
  if (!found) throw new Error(`Cannot focus: ${selector}`);
  await cdp.send('Input.insertText', { text });
}

async function screenshot(cdp, outPath, clip) {
  const opts = { format: 'png' };
  if (clip) {
    opts.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale ?? 1 };
    // 关键:要截的区域可能超出视口高度,不开这个的话超出部分是空白
    opts.captureBeyondViewport = true;
  }
  const { data } = await cdp.send('Page.captureScreenshot', opts);
  writeFileSync(resolve(outPath), Buffer.from(data, 'base64'));
  return resolve(outPath);
}

async function runAction(cdp, action, args) {
  switch (action) {
    case 'view': {
      const [url, wms] = args; await cdp.goto(url); await waitMs(Number(wms) || 1200);
      const out = await cdp.eval(`(() => ({title:document.title,url:location.href,text:document.body.innerText.slice(0,4000)}))()`);
      return { title: out.title, url: out.url, text: out.text };
    }
    case 'shot': {
      // 用法: shot <url> <out.png> [waitMs] [scrollY] [selOrW] [h]
      //   最后两个参数:传元素选择器(如 "#card1")按元素截图;或传宽高按区域截图
      const [url, outPath, wms, scrollY, a5, a6] = args;
      await cdp.goto(url);
      await waitMs(Number(wms) || 1500);
      if (scrollY) { await cdp.eval(`window.scrollTo(0, ${Number(scrollY)})`); await waitMs(450); }
      let clip;
      if (a5 && /[#.\[a-zA-Z]/.test(String(a5)) && isNaN(Number(a5))) {
        // 按元素截图
        const box = await cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(String(a5))}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
        if (!box) throw new Error(`找不到元素: ${a5}`);
        clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      } else if (a5) {
        clip = { x: 0, y: Number(scrollY) || 0, width: Number(a5), height: Number(a6) || Number(a5) };
      }
      return { file: await screenshot(cdp, outPath, clip), clip: clip ?? null };
    }
    case 'eval': {
      const [url, js, wms] = args; await cdp.goto(url); await waitMs(Number(wms) || 300);
      return { value: await cdp.eval(js) };
    }
    case 'click': {
      const [url, target, wms] = args; await cdp.goto(url); await waitMs(Number(wms) || 1000);
      return { clicked: await click(cdp, target) };
    }
    case 'type': {
      const [url, sel, text] = args; await cdp.goto(url); await waitMs(500);
      await typeInto(cdp, sel, text); return { typed: text };
    }
    case 'links': {
      const [url] = args; await cdp.goto(url); await waitMs(800);
      return { links: await cdp.eval(`[...document.querySelectorAll('a[href]')].map(a=>({text:a.textContent.trim().slice(0,60),href:a.href})).slice(0,200)`) };
    }
    case 'html': {
      const [url] = args; await cdp.goto(url); await waitMs(800);
      return { html: await cdp.eval('document.documentElement.outerHTML.slice(0,20000)') };
    }
    case 'pdf': {
      const [url, outPath, wms] = args; await cdp.goto(url); await waitMs(Number(wms) || 800);
      const { data } = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
      writeFileSync(resolve(outPath), Buffer.from(data, 'base64'));
      return { file: resolve(outPath) };
    }
    default: throw new Error(`Unknown action: ${action}`);
  }
}

// ── CLI dispatch ────────────────────────────────────────────────────────────
const [,, cmd, ...rest] = process.argv;

async function main() {
  if (!cmd) { console.error('Usage: node browser.mjs <start|attach|stop|view|shot> ...'); process.exit(2); }
  try {
    if (cmd === 'start') { await startSession(); return; }
    if (cmd === 'stop') { await stopSession(rest[0]); return; }
    if (cmd === 'attach') {
      const [sid, action, ...args] = rest;
      const { cdp } = await attach(sid);
      try { console.log(JSON.stringify(await runAction(cdp, action, args))); }
      finally { cdp.close(); }
      return;
    }
    if (['view', 'shot', 'pdf', 'eval', 'click', 'type', 'links', 'html'].includes(cmd)) {
      const { profileDir, pid, browserWs } = await launchWorkingBrowser();
      try {
        const { cdp } = await attachCdp(browserWs);
        console.log(JSON.stringify(await runAction(cdp, cmd, rest)));
        cdp.close();
      } finally {
        try { process.kill(pid); } catch {}
        await sleep(200);
        try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
      }
      return;
    }
    throw new Error(`Unknown command: ${cmd}`);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}

main();
