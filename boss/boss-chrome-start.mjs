#!/usr/bin/env node
// boss-chrome-start.mjs — 启动 BOSS 自动化专用 Chrome（CDP 9222）：boss-chrome-start.sh 的跨平台等价实现
//
// 为什么需要独立数据目录：Chrome 136+ 禁止在默认数据目录开启远程调试端口
// （"DevTools remote debugging requires a non-default data directory"），符号链接绕过也会被识破。
//
// 跨平台：
//   - Windows: 常见安装路径探测 + 注册表 App Paths 兜底
//   - macOS:   /Applications/Google Chrome.app/...
//   - Linux:   PATH 中的 google-chrome / google-chrome-stable / chromium / chromium-browser
// 数据目录可用 BOSS_CHROME_DATA_DIR 覆盖（默认：Windows 用项目内 .chrome-9222 以保住已登录态；
// Unix 沿用 ~/.config/google-chrome-boss）。
//
// 用法：npm run boss:chrome:start   （或 node boss/boss-chrome-start.mjs）
// 登录：首次启动后在该窗口登录 BOSS 直聘（登录态持久保存在数据目录）。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BOSS_CDP_PORT || 9222);
const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';

// 数据目录解析（优先级：显式环境变量 > 平台默认 Chrome 配置 > 回退到项目内目录）
//
// 2026-10-10 实测（Chrome 155 / Windows）：Chrome 拒绝在**未显式指定**数据目录时开启调试端口
// （不传 --user-data-dir 时 9222 根本不开）。但**显式写出默认配置路径**即可正常开启。
// 因此默认直接用用户真实的 Chrome 配置 —— 脚本接管的就是用户日常那个浏览器，
// Cookie / 登录态 / 书签全部一致，不存在"两个 Chrome"。
function defaultChromeDataDir() {
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(local, 'Google', 'Chrome', 'User Data');
  }
  if (IS_MAC) return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return join(homedir(), '.config', 'google-chrome');
}

// 真实配置存在就用它，否则回退到项目内独立目录（全新机器兜底，避免污染一个不存在的默认配置）
const REAL_DIR = defaultChromeDataDir();
const DATA_DIR_RAW =
  process.env.BOSS_CHROME_DATA_DIR ||
  (existsSync(REAL_DIR) ? REAL_DIR : join(ROOT, '.chrome-9222'));

// Windows 特有：路径含空格时（如 "User Data"），Chrome 155 会占住调试端口但拒绝服务
// （/json/version 404）；显式加引号也一样。实测唯一可靠解法是 8.3 短路径（无空格）。
// 8.3 名被卷禁用时原样返回——此时请改用不含空格的 BOSS_CHROME_DATA_DIR。
function winShortPath(dir) {
  if (!IS_WIN || !dir.includes(' ')) return dir;
  try {
    // 经由临时批处理取短路径，规避 cmd for-loop 在 spawnSync 下的引号转义问题
    const bat = join(tmpdir(), 'boss-chrome-shortpath.bat');
    writeFileSync(bat, '@echo off\r\nfor %%I in (%*) do @echo %%~sI\r\n', 'utf-8');
    const out = spawnSync('cmd.exe', ['/d', '/c', bat, dir], { encoding: 'utf-8' });
    const line = (out.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && !line.includes(' ') && line !== dir && existsSync(line)) return line;
  } catch { /* ignore */ }
  return dir;
}

const DATA_DIR = winShortPath(DATA_DIR_RAW);

function findChrome() {
  if (process.env.BOSS_CHROME_BIN) return process.env.BOSS_CHROME_BIN;
  const candidates = [];
  if (IS_WIN) {
    candidates.push(
      join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    );
  } else if (IS_MAC) {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return candidates.find((p) => p && existsSync(p)) || null;
}

async function cdpState() {
  // 返回: 'ready' | 'port-occupied'（端口在监听但拒绝服务调试接口） | 'free'
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? 'ready' : 'port-occupied';
  } catch {
    return 'free';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bin = findChrome();
if (!bin) {
  console.error('FAIL: 未找到 Chrome。请用 BOSS_CHROME_BIN 指定可执行文件路径。');
  process.exit(1);
}

if ((await cdpState()) === 'ready') {
  console.log(`OK: BOSS Chrome 已在运行（CDP ${PORT} 就绪，数据目录：${DATA_DIR}）`);
  process.exit(0);
}

// 关键防护：Chrome 是单实例的——若已有一个**调试接口不可用**的 Chrome 在跑（无论
// 端口没开，还是占着端口但拒绝服务——后者见于日常双击启动的 Chrome），再启动只会
// 给那个实例开个新窗口，本进程的调试参数不会生效。这里明确报错，避免"启动了但连不上"的隐蔽故障。
function chromeAlreadyRunning() {
  try {
    if (IS_WIN) {
      const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf-8' });
      return /chrome\.exe/i.test(out.stdout || '');
    }
    const out = spawnSync('pgrep', ['-x', IS_MAC ? 'Google Chrome' : 'chrome'], { encoding: 'utf-8' });
    return Boolean((out.stdout || '').trim());
  } catch {
    return false;
  }
}

if (chromeAlreadyRunning()) {
  console.error(
    `FAIL: 检测到 Chrome 已在运行，但调试接口不可用（端口 ${PORT} 未开，或被占用但返回 404）。\n`
    + '  Chrome 是单实例的：对已运行的实例再传调试参数不会生效，脚本会连不上。\n'
    + '  常见原因：日常双击图标启动的 Chrome 会占住调试端口却拒绝服务（404）。\n'
    + '  请先完全退出 Chrome（含后台进程），再重新运行本命令。',
  );
  process.exit(1);
}

const args = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${DATA_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1400,950',
];

// detached + unref：Chrome 独立于本进程存活；不重定向 stdout/stderr（Windows 下重定向会触发 crashpad 拒绝访问）。
const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
child.unref();

for (let i = 0; i < 10; i++) {
  await sleep(1000);
  if ((await cdpState()) === 'ready') {
    console.log(`OK: BOSS Chrome 已启动，CDP ${PORT} 就绪（数据目录：${DATA_DIR}）`);
    console.log('  若尚未登录 BOSS，请先在该窗口登录。');
    process.exit(0);
  }
}

console.error('FAIL: 启动失败或 CDP 端口未就绪。');
process.exit(1);
