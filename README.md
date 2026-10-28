# Market Translator

Translate the community plugin browser on demand: press a button and the plugin cards, the detail description and the full README turn into Chinese, with the English original kept in the hover tooltip. Nothing is translated automatically, so no request is sent and no credits are spent until you press a button.

![desktop only](https://img.shields.io/badge/platform-desktop-blue)

## What it does

Obsidian's community plugin browser is already translated by Obsidian itself, but the plugin names, descriptions and READMEs are written in English by their authors. This plugin adds one small toolbar above the plugin list:

```
[Translate this screen] [Translate full detail] [Restore]   translated 12 · ~723 chars · 527 left
```

- **Translate this screen** — the visible plugin card descriptions. When a plugin detail pane is open it translates just that description.
- **Translate full detail** — the detail description plus the README body (headings, paragraphs, lists, quotes, tables), up to `Items per click` entries at a time.
- **Restore** — puts the English text back.

The status text next to the buttons is the cost report: how many items are pending, roughly how many characters they are, how many were just translated and how many are left. Anything already in the cache is applied first and reported as `0 spent`.

Scrolling, switching plugins or reopening the window never triggers a translation. Everything is a click.

## Usage

1. Enable the plugin and open **Settings → Community plugins → Browse**.
2. Use the toolbar above the list, or the same three actions from the command palette.

## Network use

The English text you explicitly ask to translate is sent to exactly one of two services:

| Engine | Endpoint | When |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | you pasted your own API key in the settings |
| Google Translate | `https://translate.googleapis.com` | no key configured, free fallback |

Nothing else leaves your machine. There is no telemetry, no analytics, no account, no ads and no background request. Translations are cached in the plugin's own `data.json`, so translating the same text twice costs nothing.

The plugin does not read your vault: it only reads the text of the community browser window that you asked it to translate.

## Why desktop only

The community plugin browser opens in its own window, so the plugin needs Electron's `remote` module to reach that window's DOM. Mobile builds have no such window and no such module.

## Settings

| Setting | Meaning |
| --- | --- |
| Engine | `auto` (DeepSeek when a key exists, otherwise Google), `DeepSeek only`, `Google only` |
| DeepSeek API key | Optional. Stored in `data.json`, used only against `api.deepseek.com` |
| Base URL | Defaults to `https://api.deepseek.com`; any OpenAI-compatible gateway works |
| Model | `deepseek-chat` or `deepseek-reasoner` |
| Style | `Polish` (reads like Chinese product copy) or `Literal` |
| Items per click | Upper bound per button press, 4 to 30, default 12 |
| Clear cache | Drops every cached translation |

## Known limitations

- It is an overlay: when Obsidian re-renders the list, translated rows may flash back to English until you press the button again.
- Paragraphs containing links are replaced by translated plain text; the original with working links stays in the tooltip.
- Very large READMEs are translated in batches; the status line tells you how many are left.
- The plugin writes to the browser window's DOM, which is not an officially documented extension point. It has been tested on Obsidian 1.14.5 (desktop) only.

## 中文说明

打开 `设置 → 第三方插件 → 浏览`，列表上方会多出一条工具条：「翻译这一屏 / 翻译详情全文 / 还原」。全手动，点哪个才翻哪个，按钮右边的状态就是花费账本（还剩多少条、约多少字）。不填 DeepSeek 密钥时自动走 Google 免费接口；填了走 DeepSeek 润色。译文缓存在本地，重复翻同一段不花钱。

## License

MIT
