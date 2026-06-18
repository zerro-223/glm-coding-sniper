# GLM 抢购助手 — 暗玻璃面板 UI 重设计

> 日期: 2026-06-18  
> 类型: UI 美化  
> 范围: `createPanel` 的 `style.textContent` + `panel.innerHTML`

## 1. 设计方向

**暗玻璃 (Dark Glassmorphism)**：半透明底色 + `backdrop-filter: blur()`，在智谱白色页面上高辨识度，快速操作不费眼。

## 2. 配色 Token

| Token | 值 | 用途 |
|-------|-----|------|
| `--glass-bg` | `rgba(22, 22, 40, 0.72)` | 面板底色 |
| `--glass-border` | `rgba(255, 255, 255, 0.06)` | 面板外边框 |
| `--glass-highlight` | `rgba(255, 255, 255, 0.04)` | 卡片/输入框底 |
| `--glass-edge-glow` | `rgba(255, 255, 255, 0.08)` | 顶部折射光条 |
| `--accent` | `#ff6b6b` | 主强调色（不变） |
| `--accent-glow` | `rgba(255, 107, 107, 0.25)` | 按钮 hover 光晕 |
| `--text-primary` | `#e8e8ed` | 主文字 |
| `--text-muted` | `#8888a0` | 次级文字/标签 |

**关键 CSS**：
```css
background: rgba(22, 22, 40, 0.72);
backdrop-filter: blur(20px) saturate(140%);
-webkit-backdrop-filter: blur(20px) saturate(140%);
border: 1px solid rgba(255, 255, 255, 0.06);
```

## 3. 布局调整

面板 **280px** 宽，高度自适应。去掉 `max-height: 400px` 和 `overflow-y: auto`。

```
┌─────────────────────────┐
│  🔥 GLM 抢购          ✕ │  header: 44px, 折射光边
├─────────────────────────┤
│  ● 运行中 · 重试 #12    │  状态条，常驻，左侧彩色指示
├─────────────────────────┤
│  时间  [09:59:58]       │  开抢时间（监控模式用）
│  套餐  [Lite ▼]         │  套餐 + 周期
│  周期  [连续包月 ▼]     │
│  并发  [5] 重试[2000]   │  并发（合一）+ 重试次数
├─────────────────────────┤
│  [ ▶ 开始监控 ]         │  btn-primary, full-width
│  [ ⚡ 立即抢购 ]        │  btn-danger, full-width
│  [ 🔄 扫描 ][ ↺ 重置 ]   │  辅助按钮，half-width 各
├─────────────────────────┤
│  09:58:32 ✅ 参数已捕获  │  log: 2 行，monospace
│  09:58:30 ℹ 引擎已启动  │
└─────────────────────────┘
```

**变更清单**：
- 去掉「提前量」输入框（保留 `leadMs` 配置，默认 200ms，高级用户改 console）
- 去掉「极速并发/普通并发」分拆，合并为单个「并发」输入（映射 `normalConcurrency`；`turboConcurrency` 自动 = `normalConcurrency` × 2）
- 去掉「极速爆发/极速持续时间/抖动比例/捡漏窗口」等高级配置的 UI 输入（保留配置项，console 可改）
- 日志区缩短为固定 2 行

**保留**：键盘快捷键提示（`Alt+S/X/H`）

## 4. 动效

| 元素 | 动效 | 说明 |
|------|------|------|
| 面板 | 入场 opacity 0→1 | 只做淡入，不滑 |
| 主按钮 hover | `box-shadow` 光晕扩散 | `0→20px var(--accent-glow)` |
| 状态条 running | `glm-pulse` 脉冲 | 已有，保留 |
| 验证码高亮 | `glm-flash` | 已有，保留 |

不加其他动画。

## 5. 不变项

- Shadow DOM `mode: 'closed'`
- 拖拽、最小化、关闭/浮动按钮
- 配置持久化（localStorage）
- 键盘快捷键
- 日志、状态更新回调
- 所有 JS 逻辑零改动

## 6. 实施范围

**仅修改** `glm-coding-sniper.user.js` 中的：
- `style.textContent` — 替换全部 CSS
- `panel.innerHTML` — 替换 HTML 结构
- `SNIPER.ui._dom` 缓存引用 — 调整 id 映射
- `SNIPER.ui.bindEvents` — 适配新 input id
