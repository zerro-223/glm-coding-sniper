# GLM 暗玻璃面板 UI 重设计 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 "Precision Instrument" 紫色面板改造为暗玻璃风格（红色强调系、280px、毛玻璃、简化布局）

**Architecture:** 仅修改 `glm-coding-sniper.user.js` 中 `createPanel` 的 CSS token 系统、HTML 布局、DOM 引用映射和事件绑定。JS 业务逻辑零改动。

**Tech Stack:** Vanilla CSS (Shadow DOM), Tampermonkey userscript

**Bug Fix (carried along):** `SNIPER.updateStatus` replaces `statusBar.textContent` directly, which destroys the `.status-dot` / `.status-text` child structure. Fix to target `.status-text` span only.

## Global Constraints

- `backdrop-filter: blur(20px) saturate(140%)` + 半透明底色实现毛玻璃
- 色系：深蓝黑底 + 红色强调 `#ff6b6b`
- 面板宽度 280px，高度自适应（无 max-height / overflow）
- 去掉 `inp-lead`（提前量）、`inp-turb`（极速并发）输入框
- 按钮改为全宽堆叠布局
- JS 逻辑零改动

---

### Task 1: 替换 CSS 颜色 Token 与面板底色

**Files:**
- Modify: `glm-coding-sniper.user.js:980-1338`

**Interfaces:**
- Consumes: 无
- Produces: 新 CSS 变量定义，供后续 CSS 规则引用

- [ ] **Step 1: 替换 `:host` 内的 CSS 变量块**

定位 `style.textContent` 开头的 `:host { ... }` 块（约 L983-1006），替换为：

```css
:host {
    --glass-bg:       rgba(18, 18, 30, 0.74);
    --glass-border:   rgba(255, 255, 255, 0.06);
    --glass-input:    rgba(255, 255, 255, 0.05);
    --glass-hover:    rgba(255, 255, 255, 0.08);
    --accent:         #ff6b6b;
    --accent-glow:    rgba(255, 107, 107, 0.25);
    --cta:            #ff6b6b;
    --cta-hover:      #e55a5a;
    --cta-glow:       rgba(255, 107, 107, 0.30);
    --success:        #2ecc71;
    --warning:        #f59e0b;
    --text-primary:   #e8e8ed;
    --text-secondary: #9a9aaa;
    --text-muted:     #6b6b7d;
    --border-subtle:  rgba(255, 255, 255, 0.06);
    --radius-sm:      6px;
    --radius-md:      10px;
    --radius-lg:      14px;
    --font-ui:        system-ui, -apple-system, 'Segoe UI', sans-serif;
    --font-mono:      'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', monospace;
}
```

- [ ] **Step 2: 替换 `.panel` 背景为毛玻璃**

```css
.panel {
    width: 280px;
    background: var(--glass-bg);
    color: var(--text-primary);
    border-radius: var(--radius-lg);
    box-shadow:
        0 0 0 1px var(--glass-border),
        0 8px 40px rgba(0, 0, 0, 0.55);
    font-family: var(--font-ui);
    font-size: 12px;
    overflow: hidden;
    user-select: none;
    backdrop-filter: blur(20px) saturate(140%);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
}
```

- [ ] **Step 3: 更新 `--bg-base/--bg-surface/--bg-elevated/--border/--border-active` 等旧变量引用**

全局搜索替换 CSS 中以下旧变量 → 新变量：
- `var(--bg-base)` → `transparent`
- `var(--bg-surface)` → `transparent`
- `var(--bg-elevated)` → `var(--glass-input)`
- `var(--border)` → `var(--glass-border)`
- `var(--border-active)` → `var(--accent)`（focus 态）或 `rgba(255,255,255,0.12)`（hover 态）

- [ ] **Step 4: 在 style 末尾去掉旧 `@keyframes glm-pulse`，确保只有 `glm-flash` 和 `rush-glow`**

- [ ] **Step 5: 语法检查**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 6: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "style: replace Precision Instrument tokens with dark glass system (red accent, blur 20px, 280px)"
```

---

### Task 2: 精简 HTML 布局 + 更新 DOM 引用

**Files:**
- Modify: `glm-coding-sniper.user.js:1341-1457`

**Interfaces:**
- Consumes: Task 1 的新 CSS class 名称
- Produces: 精简的 `panel.innerHTML`，更新 `SNIPER.ui._dom`

- [ ] **Step 1: 替换 `panel.innerHTML`**

从 L1344 到 L1431 的 HTML 替换为：

```html
<div class="header" id="panel-header">
    <div class="header-brand">
        <div class="header-icon">🔥</div>
        <h3>GLM<span> 抢购</span></h3>
    </div>
    <div class="header-btns">
        <button id="btn-min" title="最小化">─</button>
        <button id="btn-close" title="关闭面板">✕</button>
    </div>
</div>
<div class="body" id="panel-body">
    <div class="row">
        <label>开抢</label>
        <input id="inp-time" type="text" value="${SNIPER.config.triggerTime}" placeholder="09:59:58">
    </div>
    <div class="row">
        <label>套餐</label>
        <select id="sel-plan">
            <option value="">自动检测</option>
        </select>
    </div>
    <div class="row">
        <label>周期</label>
        <select id="sel-cycle">
            <option value="monthly">连续包月</option>
            <option value="quarterly">连续包季 (9折)</option>
            <option value="yearly">连续包年 (8折)</option>
        </select>
    </div>
    <div class="row">
        <label>并发</label>
        <input id="inp-concur" type="number" value="${SNIPER.config.normalConcurrency}" min="1" max="20" step="1">
        <span class="row-unit">路</span>
        <label style="flex:0 0 36px;">重试</label>
        <input id="inp-retries" type="number" value="${SNIPER.config.maxRetries}" min="10" max="10000" step="10">
        <span class="row-unit">次</span>
    </div>
    <div class="status-bar idle" id="status-bar">
        <span class="status-dot"></span>
        <span class="status-text">等待操作</span>
    </div>
    <div class="log-area" id="log-area">
        <div data-placeholder style="color:var(--text-muted);">日志输出...</div>
    </div>
    <div class="btn-row">
        <button class="btn btn-primary" id="btn-monitor">▶ 开始监控</button>
    </div>
    <div class="btn-row" style="margin-top:6px;">
        <button class="btn btn-rush" id="btn-rush">⚡ 立即抢购</button>
    </div>
    <div class="btn-row" style="margin-top:6px;">
        <button class="btn btn-secondary" id="btn-scan">扫描套餐</button>
        <button class="btn btn-secondary" id="btn-reset">重置</button>
    </div>
    <div class="shortcut-hint">
        <kbd>Alt</kbd>+<kbd>S</kbd> 开始 &nbsp; <kbd>Alt</kbd>+<kbd>X</kbd> 停止 &nbsp; <kbd>Alt</kbd>+<kbd>H</kbd> 隐藏
    </div>
</div>
```

- [ ] **Step 2: 更新 `SNIPER.ui._dom` 引用**

移除 `inpLead`、`inpTurb`、`inpNormal`，新增 `inpConcur`：

```javascript
SNIPER.ui._dom = {
    shadow, host, panel,
    selPlan: shadow.getElementById('sel-plan'),
    selCycle: shadow.getElementById('sel-cycle'),
    inpTime: shadow.getElementById('inp-time'),
    inpConcur: shadow.getElementById('inp-concur'),
    inpRetries: shadow.getElementById('inp-retries'),
    statusBar: shadow.getElementById('status-bar'),
    logArea: shadow.getElementById('log-area'),
    btnMonitor: shadow.getElementById('btn-monitor'),
    btnRush: shadow.getElementById('btn-rush'),
    btnScan: shadow.getElementById('btn-scan'),
    btnReset: shadow.getElementById('btn-reset'),
    btnMin: shadow.getElementById('btn-min'),
    btnClose: shadow.getElementById('btn-close'),
};
```

- [ ] **Step 3: 更新 `SNIPER.ui.init` 中配置回填代码**

找到 `SNIPER.ui.init` 中的配置回填（约 L1473），删除 `inpLead`、`inpTurb`、`inpNormal` 的回填，添加 `inpConcur`：

```javascript
d.inpTime.value = cfg.triggerTime;
d.inpConcur.value = cfg.normalConcurrency;
d.inpRetries.value = cfg.maxRetries;
```

- [ ] **Step 4: 修复 `SNIPER.updateStatus` 不会销毁 `.status-dot`**

找到 `SNIPER.updateStatus` 函数（约 L1576），将 `bar.textContent = ...` 改为只更新 `.status-text` 子元素：

```javascript
SNIPER.updateStatus = function (status, text) {
    STATE.status = status;
    if (!SNIPER.ui._dom) return;
    const bar = SNIPER.ui._dom.statusBar;
    // 只更新文字 span，不销毁 status-dot
    const textEl = bar.querySelector('.status-text');
    if (textEl) textEl.textContent = text || status;
    bar.className = 'status-bar ' + status;
};
```

- [ ] **Step 5: 语法检查并 commit**

```bash
node --check glm-coding-sniper.user.js
git add glm-coding-sniper.user.js
git commit -m "feat: simplify panel layout — remove leadMs/turbo, add unified concurrency input"
```

---

### Task 3: 更新事件绑定适配新 input

**Files:**
- Modify: `glm-coding-sniper.user.js:1459-1501`

**Interfaces:**
- Consumes: Task 2 的新 `_dom` 引用
- Produces: 适配后的 `saveConfig` 和事件监听

- [ ] **Step 1: 更新 `saveConfig` 函数**

```javascript
const saveConfig = () => {
    SNIPER.config.targetPlan = d.selPlan.value;
    SNIPER.config.billingCycle = d.selCycle.value;
    SNIPER.config.triggerTime = d.inpTime.value;
    SNIPER.config.normalConcurrency = parseInt(d.inpConcur.value) || 5;
    // turboConcurrency 自动 = normalConcurrency × 2
    SNIPER.config.turboConcurrency = (parseInt(d.inpConcur.value) || 5) * 2;
    SNIPER.config.maxRetries = parseInt(d.inpRetries.value) || 2000;
    SNIPER.saveConfig();
};
```

- [ ] **Step 2: 更新事件监听列表**

```javascript
[d.selPlan, d.selCycle, d.inpTime, d.inpConcur, d.inpRetries].forEach(el => {
    el.addEventListener('change', saveConfig);
    el.addEventListener('input', saveConfig);
});
```

- [ ] **Step 3: 语法检查并 commit**

```bash
node --check glm-coding-sniper.user.js
git add glm-coding-sniper.user.js
git commit -m "fix: update event bindings for simplified inputs, auto-set turboConcurrency"
```

---

### Task 4: 最终验证 + 推送

**Files:**
- Modify: 无新修改

- [ ] **Step 1: 全文语法检查**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 2: 手动检查关键场景**

在浏览器 console 中验证：
- 面板右下角显示，毛玻璃效果可见
- 所有按钮可点击，无 console error
- 拖拽/最小化/关闭正常
- 配置变更后刷新页面，配置保持
- 「开始监控」「立即抢购」正常触发

- [ ] **Step 3: Push**

```bash
git push
```
