'use strict';

/*
 * Market Translator
 * Translate Obsidian's community plugin browser on demand - clicks only, nothing runs automatically.
 * Engines: DeepSeek (polished) or the public Google Translate endpoint (literal fallback).
 *
 * Plain JS, no build step: the file you are reading is the shipped main.js.
 */

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');

/* ----------------------------------------------------------------- 设置 */

const DEFAULT_SETTINGS = {
  engine: 'auto', // auto | deepseek | google
  apiKey: '', // user's own DeepSeek key, stored in this plugin's data.json
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  style: 'polish', // polish | literal
  screenBatch: 12, // max items per button click
};

/* ------------------------------------------------------------------ utils */

function sleep(ms) {
  return new Promise((r) => window.setTimeout(r, ms));
}

function debounce(fn, ms) {
  let t = null;
  return function (...args) {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn.apply(this, args), ms);
  };
}

function hash(s) {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
  return (x >>> 0).toString(36);
}

function parseJsonLoose(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

/* -------------------------------------------------------------- translate */

const SYSTEM_POLISH =
  '你是 Obsidian 社区插件市场的中文产品编辑。输入是 JSON 数组，每项形如 {"i": 序号, "t": 英文原文}。' +
  '请逐条翻译成简体中文，要求：\n' +
  '1. 技术名词保留英文原文：Markdown、CSS、API、PDF、Canvas、YAML、frontmatter、prompt、Obsidian、Vault（可写作「库」）等；\n' +
  '2. 读起来像中文产品文案：先说这段内容讲什么，准确、通顺，不逐字硬译，不添加原文没有的功能或形容词；\n' +
  '3. 不重复插件名，不以「这个插件」开头；\n' +
  '4. 长度控制在原文的 1.6 倍以内；原文分段时保留分段。\n' +
  '只输出一个 JSON 对象：键是序号的字符串，值是译文。不要代码块、不要解释。无法翻译的条目直接省略。';

const SYSTEM_LITERAL =
  '你是翻译器。输入是 JSON 数组，每项形如 {"i": 序号, "t": 英文原文}。' +
  '把每条 t 逐句直译成简体中文，保留技术名词原文，不改写、不增删信息，保留分段。' +
  '只输出一个 JSON 对象：键是序号的字符串，值是译文。不要代码块、不要解释。';

// Google 直译常见的术语翻车，统一纠回来
function polishZh(zh) {
  return String(zh || '')
    .replace(/黑曜石/g, 'Obsidian')
    .replace(/保管库/g, '库')
    .replace(/保险库/g, '库')
    .replace(/金库/g, '库');
}

async function googleTranslate(text) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' +
    encodeURIComponent(text);
  const res = await requestUrl({ url, method: 'GET', throw: false });
  if (res.status !== 200) throw new Error('Google 返回 ' + res.status);
  const data = res.json;
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Google 返回格式异常');
  const zh = data[0]
    .map((seg) => (seg && typeof seg[0] === 'string' ? seg[0] : ''))
    .join('')
    .trim();
  return polishZh(zh);
}

async function deepseekTranslate(texts, s) {
  const base = String(s.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, '');
  const sys = s.style === 'literal' ? SYSTEM_LITERAL : SYSTEM_POLISH;
  const payload = texts.map((t, i) => ({ i, t }));
  const body = {
    model: s.model || DEFAULT_SETTINGS.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    temperature: 0.2,
    max_tokens: 4000,
    stream: false,
  };

  const send = async (withJsonMode) => {
    const payloadBody = withJsonMode
      ? Object.assign({}, body, { response_format: { type: 'json_object' } })
      : body;
    return requestUrl({
      url: base + '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + String(s.apiKey || '').trim(),
      },
      body: JSON.stringify(payloadBody),
      throw: false,
    });
  };

  let res = await send(true);
  if (res.status === 400) res = await send(false); // 有些兼容网关不认 response_format
  if (res.status === 401 || res.status === 403) throw new Error('DeepSeek 密钥无效（' + res.status + '）');
  if (res.status !== 200) {
    throw new Error('DeepSeek ' + res.status + '：' + String(res.text || '').slice(0, 160));
  }
  const data = res.json || {};
  const content =
    (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  const obj = parseJsonLoose(content) || {};
  return texts.map((_, i) => {
    const v = obj[i] != null ? obj[i] : obj[String(i)];
    return typeof v === 'string' ? v.trim() : '';
  });
}

/* --------------------------------------------- 官方插件市场窗口（跨窗口翻译） */

/*
 * Obsidian 的「第三方插件」浏览窗是独立的 BrowserWindow，主渲染进程拿不到它的 DOM，
 * 但可以 remote + webContents.executeJavaScript 注入。
 *
 * 注入的 agent 做三件事，全都不联网：
 *   1) 在窗口里搭一条「翻译这一屏 / 翻译详情全文 / 还原」的工具条
 *   2) 收集还没翻的英文节点（__mzScan）
 *   3) 把主进程翻好的译文写回 DOM（__mzApply）
 * 点按钮只是把请求挂到 A.request 上；主进程每 0.8 秒做一次本地读取（不调 API），
 * 只有真的点了按钮才会消耗 token。
 */

const MZ_AGENT_JS = [
  '(function () {',
  '  var A = (window.__mzAgent = window.__mzAgent || { seq: 0, request: null });',
  '  A.v = 4;',
  '  var CARD = ".community-item-desc";',
  '  var INFO = ".community-modal-info-desc";',
  '  var README = [',
  '    ".community-modal-readme h2",',
  '    ".community-modal-readme h3",',
  '    ".community-modal-readme h4",',
  '    ".community-modal-readme p",',
  '    ".community-modal-readme li",',
  '    ".community-modal-readme blockquote",',
  '    ".community-modal-readme td"',
  '  ].join(", ");',
  '  function looksChinese(t) { return /[\\u4e00-\\u9fff]/.test(t); }',
  '  function detailOpen() { return !!document.querySelector(".community-modal-details"); }',
  '  function isDone(el, engine) { return el.dataset.mzDone === "1" && el.dataset.mzEngine === engine; }',
  '  function collect(selector, engine) {',
  '    var nodes = document.querySelectorAll(selector);',
  '    var out = [];',
  '    for (var i = 0; i < nodes.length; i++) {',
  '      var el = nodes[i];',
  '      if (el.closest("pre")) continue;',
  '      var t = (el.innerText || "").trim();',
  '      if (!t || t.length < 2) continue;',
  '      if (looksChinese(t)) continue;',
  '      if (isDone(el, engine)) continue;',
  '      if (!el.dataset.mzId) el.dataset.mzId = "z" + ++A.seq;',
  '      out.push({ id: el.dataset.mzId, t: t });',
  '    }',
  '    return out;',
  '  }',
  '  window.__mzScan = function (scope, engine) {',
  '    A.engine = engine || "";',
  '    var items;',
  '    if (scope === "detail") items = collect(INFO + ", " + README, A.engine);',
  '    else if (detailOpen()) items = collect(INFO, A.engine);',
  '    else items = collect(CARD, A.engine);',
  '    var chars = 0;',
  '    for (var i = 0; i < items.length; i++) chars += items[i].t.length;',
  '    return { items: items, chars: chars, detailOpen: detailOpen() };',
  '  };',
  '  window.__mzApply = function (map) {',
  '    var n = 0;',
  '    for (var id in map) {',
  '      var el = document.querySelector(\'[data-mz-id="\' + id + \'"]\');',
  '      if (!el) continue;',
  '      if (!el.dataset.mzOrig) el.dataset.mzOrig = (el.innerText || "").slice(0, 1200);',
  '      el.textContent = map[id];',
  '      el.dataset.mzDone = "1";',
  '      el.dataset.mzEngine = A.engine || "";',
  '      el.setAttribute("title", el.dataset.mzOrig);',
  '      n++;',
  '    }',
  '    return n;',
  '  };',
  '  window.__mzUndo = function () {',
  '    var els = document.querySelectorAll("[data-mz-orig]");',
  '    for (var i = 0; i < els.length; i++) {',
  '      els[i].textContent = els[i].dataset.mzOrig;',
  '      delete els[i].dataset.mzDone;',
  '      delete els[i].dataset.mzEngine;',
  '    }',
  '    return els.length;',
  '  };',
  '  window.__mzTake = function () { var r = A.request; A.request = null; return r; };',
  '  window.__mzStatus = function (text, tone) {',
  '    var el = document.querySelector(".mz-status-text");',
  '    if (!el) return false;',
  '    el.textContent = text || "";',
  '    el.style.color = tone === "error" ? "var(--text-error)" : tone === "ok" ? "var(--text-success)" : "var(--text-muted)";',
  '    return true;',
  '  };',
  '  function mkBtn(label, kind, primary) {',
  '    var b = document.createElement("button");',
  '    b.className = "mz-btn" + (primary ? " mz-btn-primary" : "");',
  '    b.textContent = label;',
  '    b.style.cssText =',
  '      "font-size:12px;line-height:1.6;padding:3px 10px;border-radius:6px;cursor:pointer;" +',
  '      (primary',
  '        ? "background:var(--interactive-accent);color:var(--text-on-accent);border:1px solid transparent;"',
  '        : "background:var(--interactive-normal);color:var(--text-normal);border:1px solid var(--background-modifier-border);");',
  '    b.addEventListener("click", function (e) {',
  '      e.preventDefault();',
  '      e.stopPropagation();',
  '      A.request = kind;',
  '    });',
  '    return b;',
  '  }',
  '  window.__mzBuildUI = function () {',
  '    if (document.querySelector(".mz-bar")) return "exists";',
  '    var host = document.querySelector(".community-modal-controls") || document.querySelector(".mod-community-plugin");',
  '    if (!host) return "no-host";',
  '    var bar = document.createElement("div");',
  '    bar.className = "mz-bar";',
  '    bar.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 0 2px;";',
  '    bar.appendChild(mkBtn("翻译这一屏", "page", true));',
  '    bar.appendChild(mkBtn("翻译详情全文", "detail", false));',
  '    bar.appendChild(mkBtn("还原", "undo", false));',
  '    var st = document.createElement("span");',
  '    st.className = "mz-status-text";',
  '    st.style.cssText = "font-size:11px;color:var(--text-muted);margin-left:2px;";',
  '    st.textContent = "手动翻译 · 待点按钮";',
  '    bar.appendChild(st);',
  '    host.appendChild(bar);',
  '    return "built";',
  '  };',
  '  window.__mzBuildUI();',
  '  return "ok";',
  '})()',
].join('\n');

const WINDOW_TITLE_RE = /第三方插件|社区插件|Community plugins/i;
const MZ_AGENT_VERSION = 4;

class WindowTranslator {
  constructor(plugin) {
    this.plugin = plugin;
    this.timer = null;
    this.inflight = new Map();
  }

  get remote() {
    try {
      return require('electron').remote || null;
    } catch (e) {
      return null;
    }
  }

  candidates() {
    const remote = this.remote;
    if (!remote) return [];
    try {
      return remote.BrowserWindow.getAllWindows().filter((w) => {
        try {
          return WINDOW_TITLE_RE.test(w.getTitle());
        } catch (e) {
          return false;
        }
      });
    } catch (e) {
      return [];
    }
  }

  // 这个轮询只做本地读取（搭工具条、取按钮请求），不碰网络、不耗 token
  start() {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.tick(), 800);
    this.tick();
  }

  stop() {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    for (const win of this.candidates()) {
      const key = win.id != null ? win.id : win.getTitle();
      if (this.inflight.get(key)) continue;
      this.inflight.set(key, true);
      this.pass(win)
        .catch(() => {})
        .finally(() => this.inflight.set(key, false));
    }
  }

  async pass(win) {
    if (win.isDestroyed && win.isDestroyed()) return;
    const wc = win.webContents;
    if (!wc || (wc.isDestroyed && wc.isDestroyed())) return;

    // 每轮只做一次轻探测：agent 版本对不对、工具条还在不在、有没有按钮请求
    const probe =
      '(function(){var A=window.__mzAgent;if(!A||A.v!==' +
      MZ_AGENT_VERSION +
      ')return "stale";if(window.__mzBuildUI)window.__mzBuildUI();return (window.__mzTake&&window.__mzTake())||"idle";})()';
    const req = await wc.executeJavaScript(probe);
    if (req === 'stale') {
      await wc.executeJavaScript(MZ_AGENT_JS); // 首次打开或插件更新过，注入一次
      return;
    }
    if (!req || req === 'idle') return;

    if (req === 'undo') {
      const n = await wc.executeJavaScript('window.__mzUndo()');
      await this.setStatus(wc, '已还原 ' + n + ' 处原文', 'ok');
      return;
    }
    if (req === 'page' || req === 'detail') await this.translate(win, req);
  }

  async setStatus(wc, text, tone) {
    try {
      await wc.executeJavaScript(
        'window.__mzStatus(' + JSON.stringify(String(text || '')) + ',' + JSON.stringify(tone || '') + ')'
      );
    } catch (e) {
      /* 窗口关了就忽略 */
    }
  }

  async translate(win, scope) {
    const wc = win.webContents;
    const plugin = this.plugin;
    const engine = plugin.activeEngine();

    let scan;
    try {
      scan = await wc.executeJavaScript(
        'window.__mzScan(' + JSON.stringify(scope) + ',' + JSON.stringify(engine) + ')'
      );
    } catch (e) {
      await this.setStatus(wc, '扫描失败：' + (e && e.message ? e.message : e), 'error');
      return;
    }

    const items = (scan && scan.items) || [];
    if (!items.length) {
      await this.setStatus(wc, scope === 'detail' ? '详情已经是中文了' : '这一屏没有待翻的英文', 'ok');
      return;
    }

    // 先贴缓存，命中的不花钱
    const cachedMap = {};
    const missing = [];
    for (const it of items) {
      const hit = plugin.getPlainTranslation(it.t);
      if (hit) cachedMap[it.id] = hit;
      else missing.push(it);
    }
    if (Object.keys(cachedMap).length) {
      await wc.executeJavaScript('window.__mzApply(' + JSON.stringify(cachedMap) + ')');
    }

    const cap = plugin.settings.screenBatch || 12;
    const batch = missing.slice(0, cap);
    if (!batch.length) {
      await this.setStatus(wc, '贴了 ' + Object.keys(cachedMap).length + ' 条缓存 · 本次 0 消耗', 'ok');
      return;
    }

    const chars = batch.reduce((n, b) => n + b.t.length, 0);
    const remainAll = items.length - Object.keys(cachedMap).length;
    await this.setStatus(
      wc,
      '待翻 ' + remainAll + ' 条 / 约 ' + (scan.chars || 0) + ' 字，本次 ' + batch.length + ' 条…',
      ''
    );

    const zhs = await plugin.translatePlain(batch.map((b) => b.t));
    const map2 = {};
    batch.forEach((b, i) => {
      if (zhs[i]) map2[b.id] = zhs[i];
    });
    const applied = Object.keys(map2).length
      ? await wc.executeJavaScript('window.__mzApply(' + JSON.stringify(map2) + ')')
      : 0;

    const left = items.length - Object.keys(cachedMap).length - applied;
    if (!applied) {
      await this.setStatus(wc, '翻译失败（看控制台）· 还剩 ' + left + ' 条', 'error');
      return;
    }
    await this.setStatus(
      wc,
      '已翻 ' + applied + ' 条 / 约 ' + chars + ' 字' + (left > 0 ? ' · 还剩 ' + left + ' 条，再点一次' : ' · 本屏完成'),
      'ok'
    );
  }

  async revertAll() {
    for (const win of this.candidates()) {
      try {
        await win.webContents.executeJavaScript(MZ_AGENT_JS);
        await win.webContents.executeJavaScript('window.__mzUndo()');
        await this.setStatus(win.webContents, '已还原原文', 'ok');
      } catch (e) {
        /* 忽略单个窗口失败 */
      }
    }
  }
}

/* --------------------------------------------------------------- settings */

class MarketSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '全部手动：打开「设置 → 第三方插件 → 浏览」，窗口里会出现「翻译这一屏 / 翻译详情全文 / 还原」三个按钮，点哪个才翻哪个，状态就在按钮右边。滚动出新卡片不会自动翻。',
    });

    containerEl.createEl('h3', { text: '翻译引擎' });

    new Setting(containerEl)
      .setName('引擎')
      .setDesc('auto：有 DeepSeek 密钥就用 DeepSeek，否则用 Google 免费接口')
      .addDropdown((d) => {
        d.addOption('auto', '自动（推荐）');
        d.addOption('deepseek', '只用 DeepSeek');
        d.addOption('google', '只用 Google 免费接口');
        d.setValue(s.engine).onChange(async (v) => {
          s.engine = v;
          await this.plugin.saveSettings();
          if (this.plugin.windowTranslator) this.plugin.windowTranslator.revertAll();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('DeepSeek API 密钥')
      .setDesc('留空则走 Google 免费接口（直译）。密钥存在本插件的 data.json，只用于请求 api.deepseek.com。')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('sk-...（可留空）')
          .setValue(s.apiKey)
          .onChange(
            debounce(async (v) => {
              s.apiKey = v.trim();
              await this.plugin.saveSettings();
            }, 400)
          );
      });

    new Setting(containerEl)
      .setName('接口地址')
      .setDesc('默认 https://api.deepseek.com，兼容 OpenAI 协议的网关也可以填这里')
      .addText((t) =>
        t
          .setPlaceholder('https://api.deepseek.com')
          .setValue(s.baseUrl)
          .onChange(
            debounce(async (v) => {
              s.baseUrl = v.trim() || DEFAULT_SETTINGS.baseUrl;
              await this.plugin.saveSettings();
            }, 400)
          )
      );

    new Setting(containerEl)
      .setName('模型')
      .setDesc('deepseek-chat（快、便宜）或 deepseek-reasoner')
      .addText((t) =>
        t
          .setPlaceholder('deepseek-chat')
          .setValue(s.model)
          .onChange(
            debounce(async (v) => {
              s.model = v.trim() || DEFAULT_SETTINGS.model;
              await this.plugin.saveSettings();
            }, 400)
          )
      );

    new Setting(containerEl)
      .setName('译文风格')
      .setDesc('润色：像中文产品文案；直译：逐句翻，不改写')
      .addDropdown((d) => {
        d.addOption('polish', '润色（推荐）');
        d.addOption('literal', '直译');
        d.setValue(s.style).onChange(async (v) => {
          s.style = v;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl('h3', { text: '手动翻译' });

    new Setting(containerEl)
      .setName('单次最多翻几条')
      .setDesc('点一次按钮的上限，默认 12。剩下几条会在状态里显示，想继续再点。')
      .addSlider((sl) =>
        sl
          .setLimits(4, 30, 1)
          .setValue(s.screenBatch)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.screenBatch = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('手动执行')
      .setDesc('工具条没出来时用这里，效果一样')
      .addButton((b) =>
        b.setButtonText('翻译这一屏').onClick(async () => {
          await this.plugin.runFromCommand('page');
        })
      )
      .addButton((b) =>
        b.setButtonText('翻译详情全文').onClick(async () => {
          await this.plugin.runFromCommand('detail');
        })
      )
      .addButton((b) =>
        b.setButtonText('还原原文').onClick(async () => {
          await this.plugin.windowTranslator.revertAll();
          new Notice('已还原原文');
        })
      );

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('用当前引擎翻一句，确认密钥和网络通（会花一次请求）')
      .addButton((b) =>
        b.setButtonText('测试').onClick(async () => {
          b.setDisabled(true);
          b.setButtonText('测试中…');
          try {
            const engine = this.plugin.activeEngine();
            const out =
              engine === 'deepseek'
                ? await deepseekTranslate(['Translate plugin descriptions into Chinese.'], this.plugin.engineSettings())
                : [await googleTranslate('Translate plugin descriptions into Chinese.')];
            new Notice('可用：' + (out[0] || '(空)'));
          } catch (e) {
            new Notice('失败：' + (e && e.message ? e.message : e), 8000);
          } finally {
            b.setDisabled(false);
            b.setButtonText('测试');
          }
        })
      );

    containerEl.createEl('h3', { text: '缓存' });

    new Setting(containerEl)
      .setName('已缓存译文')
      .setDesc('共 ' + this.plugin.cacheSize + ' 条，重复点按钮命中缓存不花钱')
      .addButton((b) =>
        b.setButtonText('清空').setWarning().onClick(async () => {
          this.plugin.textCache = {};
          await this.plugin.saveSettings();
          this.display();
          new Notice('翻译缓存已清空');
        })
      );
  }
}

/* ----------------------------------------------------------------- plugin */

module.exports = class MarketZhPlugin extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    this.textCache = data.textCache && typeof data.textCache === 'object' ? data.textCache : {};
    this._saveTimer = null;

    this.windowTranslator = new WindowTranslator(this);
    this.windowTranslator.start(); // 只搭工具条、收按钮点击，不发请求

    this.addCommand({
      id: 'translate-screen',
      name: '翻译「第三方插件」窗口这一屏',
      callback: () => this.runFromCommand('page'),
    });

    this.addCommand({
      id: 'translate-detail',
      name: '翻译「第三方插件」窗口详情全文',
      callback: () => this.runFromCommand('detail'),
    });

    this.addCommand({
      id: 'revert-market-window',
      name: '还原「第三方插件」窗口原文',
      callback: async () => {
        await this.windowTranslator.revertAll();
        new Notice('已还原原文');
      },
    });

    this.addCommand({
      id: 'clear-cache',
      name: '清空插件市场翻译缓存',
      callback: async () => {
        this.textCache = {};
        await this.saveSettings();
        new Notice('翻译缓存已清空');
      },
    });

    this.addSettingTab(new MarketSettingTab(this.app, this));
  }

  onunload() {
    if (this.windowTranslator) this.windowTranslator.stop();
    this.flushCache();
  }

  async runFromCommand(scope) {
    if (!this.windowTranslator.candidates().length) {
      new Notice('没找到「第三方插件」窗口，先打开 设置 → 第三方插件 → 浏览');
      return;
    }
    for (const win of this.windowTranslator.candidates()) {
      await this.windowTranslator.translate(win, scope);
    }
  }

  /* ---- 引擎与密钥 ---- */

  effectiveKey() {
    return String(this.settings.apiKey || '').trim();
  }

  engineSettings() {
    return Object.assign({}, this.settings, { apiKey: this.effectiveKey() });
  }

  activeEngine() {
    const s = this.settings;
    const hasKey = !!this.effectiveKey();
    if (s.engine === 'google') return 'google';
    if (s.engine === 'deepseek') return 'deepseek';
    return hasKey ? 'deepseek' : 'google';
  }

  /* ---- 纯文本缓存 ---- */

  // 译文策略改过就换版本号，让旧缓存自然失效
  plainKey(text) {
    return 'v3|' + hash(text);
  }

  getPlainTranslation(text) {
    const rec = this.textCache[this.plainKey(text)];
    if (!rec) return '';
    if (rec.e && rec.e !== this.activeEngine()) return '';
    return rec.zh || '';
  }

  setPlainTranslation(text, zh, engine) {
    this.textCache[this.plainKey(text)] = { zh: String(zh), e: engine || this.activeEngine() };
  }

  get cacheSize() {
    return Object.keys(this.textCache).length;
  }

  /** 翻一批纯文本，命中缓存的不发请求；返回与输入等长的数组（失败项为空串） */
  async translatePlain(texts) {
    const engine = this.activeEngine();
    const out = new Array(texts.length).fill('');
    const idx = [];
    const todo = [];
    texts.forEach((t, i) => {
      const hit = this.getPlainTranslation(t);
      if (hit) out[i] = hit;
      else {
        idx.push(i);
        todo.push(t);
      }
    });
    if (!todo.length) return out;

    try {
      let res;
      if (engine === 'deepseek') {
        res = await deepseekTranslate(todo, this.engineSettings());
      } else {
        res = [];
        for (const t of todo) {
          res.push(await googleTranslate(t));
          await sleep(120);
        }
      }
      idx.forEach((target, k) => {
        const zh = (res[k] || '').trim();
        if (zh) {
          out[target] = zh;
          this.setPlainTranslation(todo[k], zh, engine);
        }
      });
      this.scheduleSave();
    } catch (e) {
      console.error('[market-zh] translatePlain 失败', e);
    }
    return out;
  }

  /* ---- 持久化 ---- */

  scheduleSave() {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => {
      this._saveTimer = null;
      this.persist();
    }, 1500);
  }

  flushCache() {
    if (this._saveTimer) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this.persist();
  }

  async persist() {
    try {
      await this.saveData({ settings: this.settings, textCache: this.textCache });
    } catch (e) {
      console.error('[market-zh] 保存失败', e);
    }
  }

  async saveSettings() {
    await this.persist();
  }
};
