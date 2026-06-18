# GLM Coding Plan 抢购助手 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个油猴脚本，在智谱 AI GLM Coding Plan 页面上实现自动抢购，用户只需手动扫码支付。

**Architecture:** 单文件油猴脚本，IIFE + 模块对象组织。核心通过 JSON.parse/fetch/XHR 劫持在数据层面绕过前端售罄限制，配合并发重试引擎抢占名额。

**Tech Stack:** JavaScript (ES6+), Tampermonkey API, Shadow DOM, fetch/XHR interception

## Global Constraints

- 单文件: `glm-coding-sniper.user.js`
- 注入时机: `@run-at document-start`
- 匹配域名: `open.bigmodel.cn`, `www.bigmodel.cn`
- 兼容: Chrome 90+, Edge 90+, Firefox 90+
- 所有配置 localStorage 持久化
- UI 使用 Shadow DOM (mode: 'closed') 隔离

---

## File Structure

```
glm脚本/
└── glm-coding-sniper.user.js    # 单文件油猴脚本（所有模块）
```

---

### Task 1: 脚本骨架与元数据

**Files:**
- Create: `glm-coding-sniper.user.js`

**Interfaces:**
- Produces: `GLM_SNIPER` 全局命名空间对象（挂载到 IIFE 内部闭包）

- [ ] **Step 1: 创建脚本文件，写入 UserScript 头部和 IIFE 骨架**

```javascript
// ==UserScript==
// @name         GLM Coding Plan 抢购助手
// @namespace    glm-coding-sniper
// @version      1.0.0
// @description  智谱AI GLM Coding Plan 自助抢购，支持自定义套餐、定时触发、并发重试
// @author       You
// @match        https://open.bigmodel.cn/*
// @match        https://www.bigmodel.cn/*
// @match        https://bigmodel.cn/*
// @run-at       document-start
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    // ============ 默认配置 ============
    const DEFAULT_CONFIG = {
        targetPlan: '',           // 目标套餐名称，空=自动选第一个
        billingCycle: 'monthly',  // monthly / quarterly / yearly
        triggerTime: '09:59:58',  // 开抢触发时间
        leadMs: 200,              // 提前触发量(ms)
        turboConcurrency: 10,     // 极速模式并发数
        normalConcurrency: 5,     // 普通模式并发数
        maxRetries: 2000,         // 最大重试次数
        burstCount: 20,           // 极速爆发次数
        turboDuration: 5000,      // 极速持续时间(ms)
        fastInterval: 30,         // 快速重试间隔(ms)
        slowInterval: 100,        // 慢速重试间隔(ms)
        jitterRatio: 0.3,         // 抖动比例(±30%)
        pickupWindowMs: 300000,   // 捡漏窗口(5分钟)
    };

    // ============ 运行时状态 ============
    const STATE = {
        status: 'idle',           // idle | monitoring | running | success | failed
        capturedParams: null,     // 拦截到的购买请求参数
        retryCount: 0,
        startTime: 0,
        serverTimeOffset: 0,
        logs: [],
        bizId: null,
    };

    // ============ 主对象 ============
    const SNIPER = {};
    SNIPER.config = Object.assign({}, DEFAULT_CONFIG);
    SNIPER.state = STATE;

    console.log('[GLM抢购] 脚本已注入 (骨架)');
})();
```

- [ ] **Step 2: 保存文件，检查语法**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 3: 安装到 Tampermonkey，访问目标站确认 Console 中看到注入日志**

```
预期: Console 输出 "[GLM抢购] 脚本已注入 (骨架)"
```

- [ ] **Step 4: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "feat: add userscript scaffold with metadata and config"
```

---

### Task 2: 日志系统与配置持久化

**Files:**
- Modify: `glm-coding-sniper.user.js`（在 SNIPER 对象之后插入新模块）

**Interfaces:**
- Consumes: `SNIPER.config`, `SNIPER.state`
- Produces: `SNIPER.log(level, msg)`, `SNIPER.saveConfig()`, `SNIPER.loadConfig()`

- [ ] **Step 1: 在 SNIPER 对象定义之后，STATE 定义之后，添加日志和存储模块**

```javascript
    // ============ 日志系统 ============
    const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SUCCESS: 4 };
    const MAX_LOG_ENTRIES = 50;

    SNIPER.log = function (level, msg) {
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const entry = { time, level, msg };
        STATE.logs.unshift(entry);
        if (STATE.logs.length > MAX_LOG_ENTRIES) STATE.logs.pop();
        const prefix = {
            DEBUG: '🔍', INFO: 'ℹ️', WARN: '⚠️', ERROR: '❌', SUCCESS: '✅'
        }[level] || '📝';
        console.log(`[GLM抢购 ${time}] ${prefix} ${msg}`);
        // 触发日志面板更新（如果已创建）
        if (SNIPER._logCallback) SNIPER._logCallback(entry);
    };

    // 便捷方法
    ['DEBUG','INFO','WARN','ERROR','SUCCESS'].forEach(l => {
        SNIPER[l.toLowerCase()] = (msg) => SNIPER.log(l, msg);
    });

    // ============ 配置持久化 ============
    SNIPER.saveConfig = function () {
        try {
            localStorage.setItem('glm_sniper_config', JSON.stringify(SNIPER.config));
            SNIPER.debug('配置已保存');
        } catch (e) {
            SNIPER.warn('配置保存失败: ' + e.message);
        }
    };

    SNIPER.loadConfig = function () {
        try {
            const saved = localStorage.getItem('glm_sniper_config');
            if (saved) {
                const parsed = JSON.parse(saved);
                Object.assign(SNIPER.config, parsed);
                SNIPER.info('已加载保存的配置');
                return true;
            }
        } catch (e) {
            SNIPER.warn('配置加载失败，使用默认配置');
        }
        return false;
    };
```

- [ ] **Step 2: 检查语法**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 3: 在浏览器 Console 中验证**

```javascript
// 手动测试：
SNIPER.info('测试日志');
SNIPER.success('成功测试');
SNIPER.saveConfig();
// 检查 localStorage 中 glm_sniper_config 有值
```

- [ ] **Step 4: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "feat: add logging system and config persistence"
```

---

### Task 3: Shadow DOM 控制面板 UI

**Files:**
- Modify: `glm-coding-sniper.user.js`（在 SNIPER 对象之后追加 UI 模块）

**Interfaces:**
- Consumes: `SNIPER.config`, `SNIPER.log`, `SNIPER.saveConfig`, `SNIPER.loadConfig`
- Produces: `SNIPER.ui` 对象, `SNIPER._logCallback`, `SNIPER.updateStatus(status)`, `SNIPER.scanPlans()`

- [ ] **Step 1: 添加 UI 模块**

```javascript
    // ============ 控制面板 UI ============
    SNIPER.ui = {};

    SNIPER.ui.createPanel = function () {
        // 创建 Shadow DOM 宿主
        const host = document.createElement('div');
        host.id = 'glm-sniper-host';
        host.style.cssText = 'position:fixed;z-index:999999;right:12px;bottom:12px;';
        document.documentElement.appendChild(host);

        const shadow = host.attachShadow({ mode: 'closed' });

        // 内联样式
        const style = document.createElement('style');
        style.textContent = `
            * { box-sizing:border-box;margin:0;padding:0; }
            .panel {
                width: 300px;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
                color: #e0e0e0;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                font-family: 'Segoe UI', system-ui, sans-serif;
                font-size: 13px;
                overflow: hidden;
                user-select: none;
            }
            .header {
                background: rgba(255,255,255,0.05);
                padding: 10px 12px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: move;
                border-bottom: 1px solid rgba(255,255,255,0.08);
            }
            .header h3 { font-size:14px;color:#ff6b6b;margin:0; }
            .header-btns { display:flex;gap:6px; }
            .header-btns button {
                background: rgba(255,255,255,0.1);
                border: none;
                color: #ccc;
                width: 22px;
                height: 22px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                line-height: 1;
            }
            .header-btns button:hover { background: rgba(255,255,255,0.2); }
            .body {
                padding: 10px 12px;
                max-height: 400px;
                overflow-y: auto;
            }
            .section { margin-bottom: 8px; }
            .section-label {
                display: block;
                font-size: 11px;
                color: #888;
                margin-bottom: 4px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .row { display:flex;gap:8px;align-items:center;margin-bottom:6px; }
            .row label { flex:0 0 65px;font-size:12px;color:#aaa; }
            select, input {
                flex: 1;
                background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 6px;
                color: #e0e0e0;
                padding: 5px 8px;
                font-size: 12px;
                outline: none;
            }
            select:focus, input:focus {
                border-color: #ff6b6b;
            }
            select option { background:#1a1a2e; }
            .status-bar {
                padding: 8px 12px;
                background: rgba(0,0,0,0.2);
                border-radius: 6px;
                margin-bottom: 8px;
                font-size: 12px;
                text-align: center;
            }
            .status-bar.idle { border-left:3px solid #4ecdc4; }
            .status-bar.monitoring { border-left:3px solid #ffe66d; }
            .status-bar.running { border-left:3px solid #ff6b6b; }
            .status-bar.success { border-left:3px solid #2ecc71; }
            .status-bar.failed { border-left:3px solid #e74c3c; }
            .log-area {
                background: rgba(0,0,0,0.3);
                border-radius: 6px;
                padding: 6px 8px;
                max-height: 80px;
                overflow-y: auto;
                font-size: 11px;
                font-family: 'Consolas', 'Courier New', monospace;
                margin-bottom: 8px;
            }
            .log-entry { padding:1px 0;border-bottom:1px solid rgba(255,255,255,0.03); }
            .log-entry .t { color:#666;margin-right:4px; }
            .log-entry.DEBUG { color:#888; }
            .log-entry.INFO { color:#aaa; }
            .log-entry.WARN { color:#ffe66d; }
            .log-entry.ERROR { color:#ff6b6b; }
            .log-entry.SUCCESS { color:#2ecc71; }
            .btn-row { display:flex;gap:6px;flex-wrap:wrap; }
            .btn {
                flex: 1;
                min-width: 60px;
                padding: 7px 10px;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 600;
                transition: all 0.2s;
            }
            .btn:hover { transform: translateY(-1px); }
            .btn-primary {
                background: linear-gradient(135deg, #ff6b6b, #ee5a24);
                color: #fff;
            }
            .btn-primary:hover { box-shadow: 0 4px 12px rgba(255,107,107,0.4); }
            .btn-secondary { background: rgba(255,255,255,0.1); color: #ccc; }
            .btn-secondary:hover { background: rgba(255,255,255,0.2); }
            .btn-danger { background: rgba(231,76,60,0.3); color: #e74c3c; }
            .btn-danger:hover { background: rgba(231,76,60,0.5); }
            .minimized .body { display:none; }
            .shortcut-hint { font-size:10px;color:#555;text-align:center;margin-top:4px; }
        `;
        shadow.appendChild(style);

        // 面板 DOM
        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.innerHTML = `
            <div class="header" id="panel-header">
                <h3>🔥 GLM 抢购助手</h3>
                <div class="header-btns">
                    <button id="btn-min" title="最小化">─</button>
                    <button id="btn-close" title="关闭面板" style="color:#ff6b6b;">✕</button>
                </div>
            </div>
            <div class="body" id="panel-body">
                <div class="section">
                    <span class="section-label">套餐设置</span>
                    <div class="row">
                        <label>目标套餐:</label>
                        <select id="sel-plan">
                            <option value="">自动检测...</option>
                        </select>
                    </div>
                    <div class="row">
                        <label>付费周期:</label>
                        <select id="sel-cycle">
                            <option value="monthly">连续包月</option>
                            <option value="quarterly">连续包季 (9折)</option>
                            <option value="yearly">连续包年 (8折)</option>
                        </select>
                    </div>
                </div>
                <div class="section">
                    <span class="section-label">定时设置</span>
                    <div class="row">
                        <label>开抢时间:</label>
                        <input id="inp-time" type="text" value="${SNIPER.config.triggerTime}" placeholder="09:59:58">
                    </div>
                    <div class="row">
                        <label>提前量:</label>
                        <input id="inp-lead" type="number" value="${SNIPER.config.leadMs}" placeholder="200" step="10">
                        <span style="font-size:11px;color:#888;">ms</span>
                    </div>
                </div>
                <div class="section">
                    <span class="section-label">并发设置</span>
                    <div class="row">
                        <label>极速并发:</label>
                        <input id="inp-turbo" type="number" value="${SNIPER.config.turboConcurrency}" min="1" max="20" step="1">
                        <span style="font-size:11px;color:#888;">路</span>
                    </div>
                    <div class="row">
                        <label>普通并发:</label>
                        <input id="inp-normal" type="number" value="${SNIPER.config.normalConcurrency}" min="1" max="10" step="1">
                        <span style="font-size:11px;color:#888;">路</span>
                    </div>
                    <div class="row">
                        <label>最大重试:</label>
                        <input id="inp-retries" type="number" value="${SNIPER.config.maxRetries}" min="10" max="10000" step="10">
                        <span style="font-size:11px;color:#888;">次</span>
                    </div>
                </div>
                <div class="status-bar idle" id="status-bar">
                    🟢 等待操作...
                </div>
                <div class="log-area" id="log-area">
                    <div style="color:#555;">日志输出...</div>
                </div>
                <div class="btn-row">
                    <button class="btn btn-primary" id="btn-monitor">▶ 开始监控</button>
                    <button class="btn btn-primary" id="btn-rush" style="background:linear-gradient(135deg,#ff6b6b,#c0392b);">⚡ 立即抢购</button>
                </div>
                <div class="btn-row" style="margin-top:6px;">
                    <button class="btn btn-secondary" id="btn-scan">🔄 扫描套餐</button>
                    <button class="btn btn-secondary" id="btn-reset">↺ 重置</button>
                </div>
                <div class="shortcut-hint">⚡ 快捷键: Alt+S 开始 | Alt+X 停止 | Alt+H 隐藏/显示</div>
            </div>
        `;
        shadow.appendChild(panel);

        // 缓存 DOM 引用
        SNIPER.ui._dom = {
            shadow, host, panel,
            selPlan: shadow.getElementById('sel-plan'),
            selCycle: shadow.getElementById('sel-cycle'),
            inpTime: shadow.getElementById('inp-time'),
            inpLead: shadow.getElementById('inp-lead'),
            inpTurb: shadow.getElementById('inp-turbo'),
            inpNormal: shadow.getElementById('inp-normal'),
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

        // 绑定事件
        SNIPER.ui.bindEvents(shadow);
        return { host, shadow };
    };

    SNIPER.ui.bindEvents = function (shadow) {
        const d = SNIPER.ui._dom;

        // 配置变更 → 保存
        const saveConfig = () => {
            SNIPER.config.targetPlan = d.selPlan.value;
            SNIPER.config.billingCycle = d.selCycle.value;
            SNIPER.config.triggerTime = d.inpTime.value;
            SNIPER.config.leadMs = parseInt(d.inpLead.value) || 200;
            SNIPER.config.turboConcurrency = parseInt(d.inpTurb.value) || 10;
            SNIPER.config.normalConcurrency = parseInt(d.inpNormal.value) || 5;
            SNIPER.config.maxRetries = parseInt(d.inpRetries.value) || 2000;
            SNIPER.saveConfig();
        };

        [d.selPlan, d.selCycle, d.inpTime, d.inpLead, d.inpTurb, d.inpNormal, d.inpRetries].forEach(el => {
            el.addEventListener('change', saveConfig);
            el.addEventListener('input', saveConfig);
        });

        // 按钮
        d.btnMonitor.addEventListener('click', () => SNIPER.startMonitoring());
        d.btnRush.addEventListener('click', () => SNIPER.rushNow());
        d.btnScan.addEventListener('click', () => SNIPER.scanPlans());
        d.btnReset.addEventListener('click', () => SNIPER.reset());

        // 最小化
        let minimized = false;
        d.btnMin.addEventListener('click', () => {
            minimized = !minimized;
            shadow.querySelector('.panel').classList.toggle('minimized', minimized);
            d.btnMin.textContent = minimized ? '□' : '─';
        });

        // 关闭/显示
        d.btnClose.addEventListener('click', () => {
            d.host.style.display = 'none';
            SNIPER.ui._showToggle = SNIPER.ui.createToggleButton();
        });

        // 拖拽
        SNIPER.ui.makeDraggable(shadow);
    };

    SNIPER.ui.makeDraggable = function (shadow) {
        const header = shadow.getElementById('panel-header');
        const host = SNIPER.ui._dom.host;
        let dragging = false, startX, startY, origX, origY;

        header.addEventListener('mousedown', (e) => {
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = host.getBoundingClientRect();
            origX = rect.left;
            origY = rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            host.style.right = 'auto';
            host.style.bottom = 'auto';
            host.style.left = (origX + dx) + 'px';
            host.style.top = (origY + dy) + 'px';
        });

        document.addEventListener('mouseup', () => { dragging = false; });
    };

    SNIPER.ui.createToggleButton = function () {
        const btn = document.createElement('div');
        btn.id = 'glm-sniper-toggle';
        btn.innerHTML = '🔥';
        btn.style.cssText = `
            position:fixed;z-index:999999;right:12px;bottom:12px;
            width:36px;height:36px;border-radius:50%;
            background:linear-gradient(135deg,#ff6b6b,#ee5a24);
            color:#fff;font-size:18px;display:flex;
            align-items:center;justify-content:center;
            cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.4);
        `;
        btn.title = '显示 GLM 抢购助手';
        btn.addEventListener('click', () => {
            btn.remove();
            SNIPER.ui._dom.host.style.display = '';
        });
        document.documentElement.appendChild(btn);
        return btn;
    };

    // 更新日志
    SNIPER._logCallback = function (entry) {
        const logArea = SNIPER.ui._dom && SNIPER.ui._dom.logArea;
        if (!logArea) return;
        const div = document.createElement('div');
        div.className = `log-entry ${entry.level}`;
        div.innerHTML = `<span class="t">${entry.time}</span> ${entry.msg}`;
        logArea.insertBefore(div, logArea.firstChild);
        // 最多显示 5 条
        while (logArea.children.length > 5) logArea.lastChild.remove();
    };

    // 更新状态
    SNIPER.updateStatus = function (status, text) {
        STATE.status = status;
        if (!SNIPER.ui._dom) return;
        const bar = SNIPER.ui._dom.statusBar;
        bar.textContent = text || status;
        bar.className = 'status-bar ' + status;
        const icons = { idle: '🟢', monitoring: '🟡', running: '🔴', success: '✅', failed: '❌' };
        bar.textContent = (icons[status] || '') + ' ' + bar.textContent;
    };

    // 扫描套餐
    SNIPER.scanPlans = function () {
        const sel = SNIPER.ui._dom && SNIPER.ui._dom.selPlan;
        if (!sel) return;
        const currentValue = sel.value;
        sel.innerHTML = '<option value="">自动检测...</option>';

        // 尝试从页面读取套餐信息
        const planSelectors = [
            '.plan-card', '.package-item', '.product-card',
            '[class*="plan"]', '[class*="package"]', '[class*="product"]',
            '.pricing-card', '.price-card',
            'h3', 'h4', '.title',
        ];

        const plans = new Set();
        planSelectors.forEach(selector => {
            try {
                document.querySelectorAll(selector).forEach(el => {
                    const text = el.textContent.trim();
                    if (text && text.length < 50 && !text.includes('©')) {
                        const cleaned = text.replace(/\s+/g, ' ').substring(0, 30);
                        plans.add(cleaned);
                    }
                });
            } catch (e) { /* ignore */ }
        });

        // 常见套餐名
        const knownPlans = ['Lite', 'Pro', 'Max', '标准版', '高级版'];
        knownPlans.forEach(name => {
            if (document.body.innerText.includes(name)) plans.add(name);
        });

        plans.forEach(plan => {
            const opt = document.createElement('option');
            opt.value = plan;
            opt.textContent = plan;
            if (plan === currentValue) opt.selected = true;
            sel.appendChild(opt);
        });

        // 也尝试读取按钮文字识别套餐
        const buyBtnSelectors = 'button, a, .btn, [class*="buy"], [class*="purchase"]';
        document.querySelectorAll(buyBtnSelectors).forEach(btn => {
            const text = btn.textContent.trim();
            if (text.includes('购买') || text.includes('订阅') || text.includes('抢购')) {
                const parentText = btn.closest('div,section,li')?.textContent?.trim()?.substring(0, 50);
                if (parentText) {
                    for (const name of knownPlans) {
                        if (parentText.includes(name)) {
                            plans.add(name);
                            const opt = document.createElement('option');
                            opt.value = name;
                            opt.textContent = name + ' (从按钮识别)';
                            sel.appendChild(opt);
                        }
                    }
                }
            }
        });

        const count = plans.size;
        SNIPER.info(`扫描完成，发现 ${count} 个可能的套餐`);
        if (currentValue && plans.has(currentValue)) {
            sel.value = currentValue;
        }
    };

    // 初始化 UI
    SNIPER.ui.init = function () {
        SNIPER.loadConfig();
        const { host, shadow } = SNIPER.ui.createPanel();

        // 回填配置
        const d = SNIPER.ui._dom;
        const cfg = SNIPER.config;
        d.selCycle.value = cfg.billingCycle;
        d.inpTime.value = cfg.triggerTime;
        d.inpLead.value = cfg.leadMs;
        d.inpTurb.value = cfg.turboConcurrency;
        d.inpNormal.value = cfg.normalConcurrency;
        d.inpRetries.value = cfg.maxRetries;

        SNIPER.info('控制面板已初始化');
        SNIPER.scanPlans();
        return host;
    };
```

- [ ] **Step 2: 检查语法**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 3: 在目标页面验证**

```
预期: 页面右下角出现控制面板，可拖拽、可最小化、可关闭
       套餐下拉框有选项
       修改配置后刷新，配置保持
```

- [ ] **Step 4: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "feat: add Shadow DOM control panel UI with drag, minimize, config persistence"
```

---

### Task 4: 请求拦截器（核心 — JSON.parse / fetch / XHR 劫持）

**Files:**
- Modify: `glm-coding-sniper.user.js`

**Interfaces:**
- Consumes: `SNIPER.state`
- Produces: `SNIPER.intercept.install()`, `SNIPER.intercept.uninstall()`

- [ ] **Step 1: 在 UI 模块之前（TIMER 之后）添加拦截器模块**

```javascript
    // ============ 请求拦截器 ============
    SNIPER.intercept = {
        _origJSONParse: JSON.parse,
        _origFetch: window.fetch,
        _origXHRSend: XMLHttpRequest.prototype.send,
        _observers: [],
        _active: false,
    };

    // 深度修改 JSON 数据：将售罄/禁用标记改为 false
    SNIPER.intercept._deepPatch = function (obj, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 20) return;
        if (Array.isArray(obj)) {
            obj.forEach(item => SNIPER.intercept._deepPatch(item, depth + 1));
            return;
        }
        // 强制改为 false 的属性
        const FALSE_KEYS = ['isSoldOut', 'soldOut', 'isServerBusy', 'serverBusy'];
        for (const key of FALSE_KEYS) {
            if (key in obj && obj[key] !== false) {
                obj[key] = false;
                SNIPER.debug(`JSON patch: ${key} → false`);
            }
        }
        // disabled 需要上下文判断（对象包含商品标识才改）
        if ('disabled' in obj && obj.disabled !== false) {
            const hasProductMarker = obj.price !== undefined
                || obj.productId !== undefined
                || obj.planId !== undefined
                || obj.id !== undefined;
            if (hasProductMarker) {
                obj.disabled = false;
                SNIPER.debug(`JSON patch: disabled → false (商品上下文)`);
            }
        }
        // 递归处理子对象
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                SNIPER.intercept._deepPatch(obj[key], depth + 1);
            }
        }
    };

    // JSON.parse 劫持
    SNIPER.intercept._hijackJSON = function () {
        const self = SNIPER.intercept;
        JSON.parse = function (text, reviver) {
            const result = self._origJSONParse.call(JSON, text, reviver);
            try {
                self._deepPatch(result);
            } catch (e) {
                // 静默失败，不破坏原始行为
            }
            return result;
        };
        // 伪装成原生
        JSON.parse.toString = function () { return 'function parse() { [native code] }'; };
    };

    // fetch 劫持
    SNIPER.intercept._hijackFetch = function () {
        const self = SNIPER.intercept;
        window.fetch = function (input, init) {
            // 捕获请求参数
            const url = typeof input === 'string' ? input : (input.url || input.href || '');
            if (url.includes('preview') || url.includes('order') || url.includes('purchase')
                || url.includes('subscribe') || url.includes('create') || url.includes('pay')) {
                const body = init && init.body;
                if (body) {
                    try {
                        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
                        STATE.capturedParams = {
                            url: url,
                            body: parsed,
                            headers: init && init.headers ? { ...init.headers } : {},
                            method: (init && init.method) || 'POST',
                            capturedAt: Date.now(),
                        };
                        SNIPER.info(`捕获请求: ${url}`);
                        SNIPER.debug('请求参数: ' + JSON.stringify(parsed).substring(0, 200));
                    } catch (e) {
                        STATE.capturedParams = {
                            url, body,
                            method: (init && init.method) || 'POST',
                            capturedAt: Date.now(),
                        };
                    }
                }
            }

            // 发起原始请求，但拦截响应
            const promise = self._origFetch.call(window, input, init);
            return promise.then(response => {
                // 克隆响应以读取 JSON
                if (response && response.clone && response.headers
                    && response.headers.get('content-type')?.includes('json')) {
                    const clone = response.clone();
                    clone.json().then(data => {
                        self._deepPatch(data);
                    }).catch(() => {});
                }
                return response;
            });
        };
        window.fetch.toString = function () { return 'function fetch() { [native code] }'; };
    };

    // XMLHttpRequest 劫持
    SNIPER.intercept._hijackXHR = function () {
        const self = SNIPER.intercept;
        XMLHttpRequest.prototype.send = function (body) {
            const xhr = this;
            // 捕获请求
            const url = (xhr._url || '');
            if (url.includes('preview') || url.includes('order') || url.includes('purchase')
                || url.includes('subscribe') || url.includes('create') || url.includes('pay')) {
                if (body) {
                    try {
                        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
                        STATE.capturedParams = {
                            url,
                            body: parsed,
                            headers: {},
                            method: xhr._method || 'POST',
                            capturedAt: Date.now(),
                        };
                        SNIPER.info(`捕获 XHR: ${url}`);
                    } catch (e) { /* ignore */ }
                }
            }
            // 拦截响应
            const origOnReady = xhr.onreadystatechange;
            xhr.onreadystatechange = function (ev) {
                if (xhr.readyState === 4 && xhr.responseType === '' || xhr.responseType === 'text') {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        self._deepPatch(data);
                        // 注意：无法直接修改 responseText，但页面会通过 JSON.parse 解析
                        // JSON.parse 已被劫持，会自动 patch
                    } catch (e) { /* ignore */ }
                }
                if (origOnReady) origOnReady.call(xhr, ev);
            };
            return self._origXHRSend.call(this, body);
        };
        XMLHttpRequest.prototype.send.toString = function () { return 'function send() { [native code] }'; };

        // 也需要劫持 open 来捕获 URL
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            this._url = url;
            this._method = method;
            return origOpen.apply(this, arguments);
        };
    };

    // MutationObserver: 自动移除 disabled 属性
    SNIPER.intercept._installDOMObserver = function () {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach(m => {
                m.addedNodes.forEach(node => {
                    if (node.nodeType !== 1) return;
                    // 移除新增节点的 disabled 属性
                    node.querySelectorAll('[disabled], .is-disabled, .disabled').forEach(el => {
                        el.removeAttribute('disabled');
                        el.classList.remove('is-disabled', 'disabled');
                    });
                    if (node.matches && (node.hasAttribute('disabled')
                        || node.classList.contains('is-disabled'))) {
                        node.removeAttribute('disabled');
                        node.classList.remove('is-disabled', 'disabled');
                    }
                });
                // 处理属性变化
                if (m.type === 'attributes' && m.attributeName === 'disabled'
                    && m.target.nodeType === 1) {
                    m.target.removeAttribute('disabled');
                }
            });
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['disabled'],
        });
        SNIPER.intercept._observers.push(observer);
    };

    // 安装全部拦截
    SNIPER.intercept.install = function () {
        if (SNIPER.intercept._active) return;
        SNIPER.intercept._hijackJSON();
        SNIPER.intercept._hijackFetch();
        SNIPER.intercept._hijackXHR();
        SNIPER.intercept._installDOMObserver();
        SNIPER.intercept._active = true;
        SNIPER.success('拦截器已激活 (JSON/Fetch/XHR/DOM)');
    };

    // 卸载（用于调试）
    SNIPER.intercept.uninstall = function () {
        JSON.parse = SNIPER.intercept._origJSONParse;
        window.fetch = SNIPER.intercept._origFetch;
        XMLHttpRequest.prototype.send = SNIPER.intercept._origXHRSend;
        SNIPER.intercept._observers.forEach(o => o.disconnect());
        SNIPER.intercept._observers = [];
        SNIPER.intercept._active = false;
        SNIPER.warn('拦截器已卸载');
    };
```

- [ ] **Step 2: 检查语法**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 3: 在目标页面验证**

```
预期: 页面加载后 Console 显示 "拦截器已激活"
       按钮从置灰变为可点击
       点击购买按钮后 Console 显示 "捕获请求: ..."
```

- [ ] **Step 4: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "feat: add request interceptor (JSON.parse/fetch/XHR hijacking + DOM observer)"
```

---

### Task 5: 反检测模块

**Files:**
- Modify: `glm-coding-sniper.user.js`

**Interfaces:**
- Consumes: None (独立模块)
- Produces: `SNIPER.antidetect.install()`, `SNIPER.antidetect.randomizeHeaders()`

- [ ] **Step 1: 在拦截器模块之后添加反检测模块**

```javascript
    // ============ 反检测模块 ============
    SNIPER.antidetect = {
        _active: false,
    };

    SNIPER.antidetect.randomizeHeaders = function () {
        const languages = ['zh-CN', 'zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8',
            'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'];
        const platforms = ['Win32', 'Win32', 'Win32', 'MacIntel'];
        return {
            'X-Request-Id': 'req_' + Math.random().toString(36).substring(2, 15)
                + Math.random().toString(36).substring(2, 15),
            'X-Timestamp': String(Date.now() + Math.floor((Math.random() - 0.5) * 4000)),
            'Accept-Language': languages[Math.floor(Math.random() * languages.length)],
            'Sec-Ch-Ua-Platform': platforms[Math.floor(Math.random() * platforms.length)],
        };
    };

    SNIPER.antidetect.install = function () {
        if (SNIPER.antidetect._active) return;

        // 伪装原生 toString（fetch 和 XHR 已在拦截器中伪装）
        const origFnToString = Function.prototype.toString;
        const NATIVE_PATTERNS = [
            { fn: 'fetch', template: 'function fetch() { [native code] }' },
            { fn: 'XMLHttpRequest.prototype.send', template: 'function send() { [native code] }' },
            { fn: 'JSON.parse', template: 'function parse() { [native code] }' },
        ];

        // 劫持 Function.prototype.toString
        Function.prototype.toString = function () {
            // 检查是否是我们劫持过的函数
            if (this === window.fetch) return 'function fetch() { [native code] }';
            if (this === XMLHttpRequest.prototype.send) return 'function send() { [native code] }';
            if (this === JSON.parse) return 'function parse() { [native code] }';
            return origFnToString.call(this);
        };
        Function.prototype.toString.toString = function () {
            return 'function toString() { [native code] }';
        };

        SNIPER.antidetect._active = true;
        SNIPER.debug('反检测模块已激活');
    };
```

- [ ] **Step 2: 检查语法**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 3: 在目标页面 Console 验证**

```javascript
// 在 Console 中执行:
fetch.toString()
// 预期: 'function fetch() { [native code] }'
JSON.parse.toString()
// 预期: 'function parse() { [native code] }'
```

- [ ] **Step 4: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "feat: add anti-detection module (toString masking, header randomization)"
```

---

### Task 6: 并发重试引擎

**Files:**
- Modify: `glm-coding-sniper.user.js`

**Interfaces:**
- Consumes: `SNIPER.config`, `SNIPER.state`, `SNIPER.antidetect.randomizeHeaders`
- Produces: `SNIPER.engine.start()`, `SNIPER.engine.stop()`

- [ ] **Step 1: 在反检测模块之后添加并发引擎**

```javascript
    // ============ 并发重试引擎 ============
    SNIPER.engine = {
        _controllers: [],
        _running: false,
        _turboTimeout: null,
        _pickupTimeout: null,
    };

    // 计算自适应间隔
    SNIPER.engine._getInterval = function (retryCount) {
        const cfg = SNIPER.config;
        if (retryCount < cfg.burstCount) return 0;
        const base = retryCount < 100 ? cfg.fastInterval : cfg.slowInterval;
        const jitter = base * cfg.jitterRatio * (Math.random() * 2 - 1);  // ±30%
        return Math.max(0, Math.floor(base + jitter));
    };

    // 当前并发数
    SNIPER.engine._getConcurrency = function () {
        const elapsed = Date.now() - STATE.startTime;
        if (elapsed < SNIPER.config.turboDuration) {
            return SNIPER.config.turboConcurrency;
        }
        return SNIPER.config.normalConcurrency;
    };

    // 发送单个 preview 请求（带 AbortController）
    SNIPER.engine._sendPreview = function (controller) {
        if (!STATE.capturedParams) {
            return Promise.reject(new Error('无捕获的请求参数'));
        }
        const params = STATE.capturedParams;
        const headers = {
            'Content-Type': 'application/json',
            ...SNIPER.antidetect.randomizeHeaders(),
        };
        return fetch(params.url, {
            method: params.method,
            headers: headers,
            body: typeof params.body === 'string' ? params.body : JSON.stringify(params.body),
            signal: controller.signal,
            credentials: 'include',
        }).then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        }).then(data => {
            // 检查返回是否包含 bizId
            const bizId = data.bizId || data.biz_id || data.orderId || data.order_id
                || (data.data && (data.data.bizId || data.data.biz_id));
            if (bizId) {
                SNIPER.success(`获得 bizId: ${bizId}`);
                return { bizId, data };
            }
            // 也检查是否售罄
            if (data.soldOut || data.isSoldOut || data.status === 'SOLD_OUT') {
                throw new Error('SOLD_OUT');
            }
            // 有其他错误信息
            if (data.msg || data.message) {
                throw new Error(data.msg || data.message);
            }
            throw new Error('NO_BIZ_ID');
        });
    };

    // check 校验 bizId
    SNIPER.engine._checkBizId = function (bizId) {
        // 尝试常见的 check 端点
        const baseUrl = STATE.capturedParams ? STATE.capturedParams.url : '';
        const checkUrls = [
            baseUrl.replace(/preview/gi, 'check'),
            baseUrl.replace(/preview/gi, 'verify'),
            '/api/check',
            '/api/order/check',
        ];
        // 优先使用修改后的 URL
        const checkUrl = checkUrls[0];

        return fetch(checkUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...SNIPER.antidetect.randomizeHeaders(),
            },
            body: JSON.stringify({ bizId: bizId }),
            credentials: 'include',
        }).then(res => res.json()).then(data => {
            const status = data.status || data.state || '';
            if (status === 'OK' || status === 'SUCCESS' || status === 'ACTIVE' || data.valid === true) {
                return { valid: true, data };
            }
            if (status === 'EXPIRE' || status === 'EXPIRED' || data.valid === false) {
                return { valid: false, expired: true, data };
            }
            // 其他返回码则乐观认为有效
            return { valid: true, data };
        });
    };

    // 并发 race：任一成功即取消其它
    SNIPER.engine._racePreview = function (concurrency) {
        const controllers = [];
        const promises = [];

        for (let i = 0; i < concurrency; i++) {
            const ctrl = new AbortController();
            controllers.push(ctrl);
            promises.push(SNIPER.engine._sendPreview(ctrl));
        }

        SNIPER.engine._controllers = controllers;

        return Promise.race(promises).then(result => {
            // 取消其余请求
            controllers.forEach(c => { try { c.abort(); } catch (e) { /* ignore */ } });
            return result;
        }).catch(err => {
            controllers.forEach(c => { try { c.abort(); } catch (e) { /* ignore */ } });
            throw err;
        });
    };

    // 主循环
    SNIPER.engine._loop = async function () {
        const cfg = SNIPER.config;
        STATE.retryCount = 0;

        while (SNIPER.engine._running && STATE.retryCount < cfg.maxRetries) {
            const concurrency = SNIPER.engine._getConcurrency();
            const interval = SNIPER.engine._getInterval(STATE.retryCount);

            try {
                SNIPER.debug(`第 ${STATE.retryCount + 1} 次尝试 (${concurrency}路并发, 间隔${interval}ms)`);
                const { bizId } = await SNIPER.engine._racePreview(concurrency);

                // preview 成功 → check 校验
                SNIPER.info(`preview 成功，bizId: ${bizId}，开始 check 校验...`);
                const checkResult = await SNIPER.engine._checkBizId(bizId);

                if (checkResult.valid) {
                    STATE.bizId = bizId;
                    SNIPER.success(`✅ 抢购成功! bizId: ${bizId}`);
                    SNIPER.engine._running = false;
                    SNIPER.updateStatus('success', '✅ 抢购成功! 请立即扫码支付');
                    SNIPER.engine._onSuccess(bizId, checkResult.data);
                    return;
                } else if (checkResult.expired) {
                    SNIPER.warn('bizId 已过期，重试中...');
                }
            } catch (err) {
                if (err.message === 'SOLD_OUT') {
                    SNIPER.debug('售罄，继续重试...');
                } else if (err.name === 'AbortError') {
                    // 被 race 取消，正常
                } else {
                    SNIPER.debug(`请求失败: ${err.message}`);
                }
            }

            STATE.retryCount++;

            // 等待间隔
            if (interval > 0 && SNIPER.engine._running) {
                await new Promise(r => setTimeout(r, interval));
            }
        }

        if (STATE.retryCount >= cfg.maxRetries) {
            SNIPER.warn('达到最大重试次数');
        }
        if (SNIPER.engine._running) {
            SNIPER.updateStatus('failed', '❌ 抢购未成功');
            SNIPER.engine._running = false;
        }
    };

    // 成功回调
    SNIPER.engine._onSuccess = function (bizId, data) {
        // 播放提示音
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            [800, 1000, 1200].forEach((freq, i) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.frequency.value = freq;
                osc.type = 'square';
                gain.gain.value = 0.3;
                osc.start(audioCtx.currentTime + i * 0.15);
                osc.stop(audioCtx.currentTime + i * 0.15 + 0.1);
            });
        } catch (e) { /* ignore */ }

        // 浏览器通知
        if (typeof GM_notification === 'function') {
            GM_notification({
                title: 'GLM 抢购成功!',
                text: `bizId: ${bizId}\n请立即完成支付!`,
                timeout: 10000,
            });
        } else if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('GLM 抢购成功!', {
                body: `bizId: ${bizId}\n请立即完成支付!`,
            });
        }

        // 触发支付弹窗恢复
        SNIPER.paymentRecovery.attempt(bizId);
    };

    // 启动引擎
    SNIPER.engine.start = function () {
        if (SNIPER.engine._running) {
            SNIPER.warn('引擎已在运行中');
            return;
        }
        if (!STATE.capturedParams) {
            SNIPER.warn('未获取到请求参数，请先在页面上点击一次购买按钮');
            SNIPER.updateStatus('idle', '⚠️ 请先在页面点击购买按钮以捕获参数');
            return;
        }

        SNIPER.engine._running = true;
        STATE.startTime = Date.now();
        STATE.retryCount = 0;
        STATE.status = 'running';
        SNIPER.updateStatus('running', '🔴 抢购中...');

        // 启动拾漏定时器 (5分钟后自动停止)
        SNIPER.engine._pickupTimeout = setTimeout(() => {
            if (SNIPER.engine._running) {
                SNIPER.warn('捡漏窗口结束，停止重试');
                SNIPER.engine.stop();
            }
        }, SNIPER.config.pickupWindowMs);

        // 启动主循环
        SNIPER.engine._loop().catch(err => {
            SNIPER.error('引擎异常: ' + err.message);
            SNIPER.engine.stop();
        });

        SNIPER.info(`引擎已启动 (${SNIPER.engine._getConcurrency()}路并发)`);
    };

    // 停止引擎
    SNIPER.engine.stop = function () {
        SNIPER.engine._running = false;
        clearTimeout(SNIPER.engine._pickupTimeout);
        SNIPER.engine._controllers.forEach(c => {
            try { c.abort(); } catch (e) { /* ignore */ }
        });
        SNIPER.engine._controllers = [];
        SNIPER.updateStatus('idle', '已停止');
        SNIPER.info('引擎已停止');
    };
```

- [ ] **Step 2: 检查语法**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 3: 在目标页面验证**

```
预期: 点击一次购买按钮 → 参数被捕获
       点击「立即抢购」→ 引擎开始并发请求
       Console 显示重试日志
```

- [ ] **Step 4: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "feat: add concurrency engine with 3-phase adaptive interval and preview→check pipeline"
```

---

### Task 7: 高精度定时器 + 服务器时间校准

**Files:**
- Modify: `glm-coding-sniper.user.js`

**Interfaces:**
- Consumes: `SNIPER.config`, `SNIPER.engine`
- Produces: `SNIPER.timer.schedule(targetTime)`, `SNIPER.timer.calibrate()`

- [ ] **Step 1: 在引擎模块之后添加定时器模块**

```javascript
    // ============ 高精度定时器 ============
    SNIPER.timer = {
        _rafId: null,
        _targetTime: 0,
        _callback: null,
        _calibrated: false,
    };

    // 服务器时间校准
    SNIPER.timer.calibrate = async function () {
        SNIPER.info('正在校准服务器时间...');
        const t0 = performance.now();
        try {
            const resp = await fetch(window.location.origin + '/', {
                method: 'HEAD',
                cache: 'no-store',
                headers: SNIPER.antidetect.randomizeHeaders(),
            });
            const t1 = performance.now();
            const serverDate = resp.headers.get('Date');
            if (serverDate) {
                const serverTime = new Date(serverDate).getTime();
                const rtt = t1 - t0;
                const estimatedServerTime = serverTime + rtt / 2;
                STATE.serverTimeOffset = estimatedServerTime - Date.now();
                SNIPER.success(`服务器时间已校准 (偏差: ${STATE.serverTimeOffset > 0 ? '+' : ''}${Math.round(STATE.serverTimeOffset)}ms, RTT: ${Math.round(rtt)}ms)`);
                SNIPER.timer._calibrated = true;
                return STATE.serverTimeOffset;
            }
        } catch (e) {
            SNIPER.warn('服务器时间校准失败，使用本地时间: ' + e.message);
        }
        STATE.serverTimeOffset = 0;
        SNIPER.timer._calibrated = true;
        return 0;
    };

    // 获取当前服务器时间
    SNIPER.timer.now = function () {
        return Date.now() + STATE.serverTimeOffset;
    };

    // 解析时间字符串 "HH:MM:SS" 为今天的毫秒时间戳
    SNIPER.timer._parseTimeStr = function (timeStr) {
        const parts = timeStr.split(':').map(Number);
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
            parts[0] || 9, parts[1] || 59, parts[2] || 58, 0);
        return target.getTime();
    };

    // 高精度定时：rAF + performance.now
    SNIPER.timer.schedule = function (timeStr, callback) {
        const targetLocal = SNIPER.timer._parseTimeStr(timeStr);
        // 加上服务器时间偏差得到期望触发时的服务器时间对应本地时间
        const effectiveLocal = targetLocal - STATE.serverTimeOffset - SNIPER.config.leadMs;
        SNIPER.timer._targetTime = effectiveLocal;
        SNIPER.timer._callback = callback;

        SNIPER.info(`已设置定时触发: ${timeStr} (提前 ${SNIPER.config.leadMs}ms)`);
        SNIPER.updateStatus('monitoring', `🟡 监控中，目标时间: ${timeStr}`);

        const tick = () => {
            const now = performance.now();
            // performance.now 起点与 Date.now 不同，需要用差值
            const nowAbs = Date.now() + (performance.now() - now);
            const diff = effectiveLocal - Date.now();

            if (diff <= 0) {
                SNIPER.info('⏰ 时间到! 触发抢购');
                SNIPER.timer._rafId = null;
                if (callback) callback();
                return;
            }

            if (diff < 10) {
                // 最后 10ms 使用微任务精度
                setTimeout(tick, 0);
            } else {
                SNIPER.timer._rafId = requestAnimationFrame(tick);
            }
        };

        SNIPER.timer._rafId = requestAnimationFrame(tick);
    };

    // 取消定时
    SNIPER.timer.cancel = function () {
        if (SNIPER.timer._rafId) {
            cancelAnimationFrame(SNIPER.timer._rafId);
            SNIPER.timer._rafId = null;
        }
        SNIPER.timer._callback = null;
        SNIPER.info('定时已取消');
    };
```

- [ ] **Step 2: 检查语法**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 3: 在目标页面验证**

```
预期: 设置开抢时间后点击「开始监控」
      状态变为 🟡 监控中
      到达时间后自动触发抢购
```

- [ ] **Step 4: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "feat: add high-precision timer with server time calibration"
```

---

### Task 8: 支付弹窗恢复 & 验证码监控

**Files:**
- Modify: `glm-coding-sniper.user.js`

**Interfaces:**
- Consumes: `SNIPER.state`, `SNIPER.engine._onSuccess`
- Produces: `SNIPER.paymentRecovery.attempt(bizId)`, `SNIPER.captchaMonitor.watch()`

- [ ] **Step 1: 在定时器模块之后添加支付恢复和验证码监控模块**

```javascript
    // ============ 支付弹窗恢复 ============
    SNIPER.paymentRecovery = {
        _attempts: 0,
        _maxAttempts: 4,
    };

    SNIPER.paymentRecovery.attempt = function (bizId) {
        SNIPER.paymentRecovery._attempts = 0;
        SNIPER.paymentRecovery._tryNext(bizId);
    };

    SNIPER.paymentRecovery._tryNext = function (bizId) {
        const attempt = SNIPER.paymentRecovery._attempts;
        SNIPER.paymentRecovery._attempts++;

        if (attempt >= SNIPER.paymentRecovery._maxAttempts) {
            SNIPER.warn('所有弹窗恢复策略已尝试完毕');
            return;
        }

        SNIPER.info(`弹窗恢复策略 ${attempt + 1}/${SNIPER.paymentRecovery._maxAttempts}`);

        switch (attempt) {
            case 0:
                // 第1层：清除遮罩和弹窗包装器
                document.querySelectorAll('.el-dialog__wrapper, .v-modal, .el-overlay, '
                    + '[class*="modal"], [class*="overlay"], [class*="mask"]')
                    .forEach(el => {
                        if (el.style.display !== 'none') el.remove();
                    });
                SNIPER.debug('已清除遮罩层');
                setTimeout(() => SNIPER.paymentRecovery._checkAndRetry(bizId), 500);
                break;

            case 1:
                // 第2层：重新点击购买按钮
                const buyBtns = document.querySelectorAll(
                    'button, a, .btn, [class*="buy"], [class*="purchase"], [class*="pay"]');
                for (const btn of buyBtns) {
                    const text = btn.textContent.trim();
                    if (text.includes('购买') || text.includes('支付') || text.includes('订阅')
                        || text.includes('确认') || text.includes('下单')) {
                        btn.click();
                        SNIPER.debug(`重新触发按钮: ${text}`);
                        break;
                    }
                }
                setTimeout(() => SNIPER.paymentRecovery._checkAndRetry(bizId), 1000);
                break;

            case 2:
                // 第3层：直接请求支付链接
                const payUrls = [
                    '/api/pay/' + bizId,
                    '/api/order/' + bizId + '/pay',
                    '/api/payment?bizId=' + bizId,
                ];
                payUrls.forEach(url => {
                    fetch(url, { credentials: 'include' })
                        .then(r => r.json())
                        .then(data => {
                            const payUrl = data.payUrl || data.url || data.link;
                            if (payUrl) {
                                SNIPER.success(`获取到支付链接: ${payUrl}`);
                                window.open(payUrl, '_blank');
                            }
                        }).catch(() => {});
                });
                setTimeout(() => SNIPER.paymentRecovery._checkAndRetry(bizId), 2000);
                break;

            case 3:
                // 第4层：Vue 组件树兜底
                SNIPER.paymentRecovery._vuePatch(bizId);
                break;
        }
    };

    SNIPER.paymentRecovery._checkAndRetry = function (bizId) {
        // 检查支付弹窗是否出现
        const dialog = document.querySelector('.el-dialog__wrapper, [class*="payment"], '
            + '[class*="pay-dialog"], [class*="checkout"]');
        if (!dialog || dialog.style.display === 'none') {
            SNIPER.paymentRecovery._tryNext(bizId);
        } else {
            SNIPER.success('支付弹窗已出现');
        }
    };

    SNIPER.paymentRecovery._vuePatch = function (bizId) {
        SNIPER.debug('尝试 Vue 组件树兜底...');
        // 遍历所有 DOM 元素的 __vue__ 属性
        const walk = (el) => {
            const vue = el.__vue__ || el.__vue_app__ || el._vueInstance;
            if (vue) {
                SNIPER.paymentRecovery._patchVue(vue, bizId);
            }
            el.childNodes.forEach(walk);
        };
        try { walk(document.body); } catch (e) { /* ignore */ }

        // 也尝试从根节点
        const rootEl = document.getElementById('app') || document.getElementById('__nuxt')
            || document.getElementById('__next') || document.body.firstElementChild;
        if (rootEl) {
            const vueApp = rootEl.__vue_app__;
            if (vueApp && vueApp.config && vueApp.config.globalProperties) {
                SNIPER.debug('发现 Vue app 实例');
            }
        }

        SNIPER.warn('Vue patch 已完成（如仍未出现弹窗，请手动操作）');
    };

    SNIPER.paymentRecovery._patchVue = function (vue, bizId) {
        try {
            if (vue.payDialogVisible !== undefined) {
                vue.payDialogVisible = true;
                SNIPER.debug('设置 payDialogVisible = true');
            }
            if (vue.isServerBusy !== undefined) {
                vue.isServerBusy = false;
                SNIPER.debug('设置 isServerBusy = false');
            }
            if (vue.bizId !== undefined) vue.bizId = bizId;
        } catch (e) { /* ignore */ }
    };

    // ============ 验证码监控 ============
    SNIPER.captchaMonitor = {
        _observer: null,
        _watching: false,
    };

    SNIPER.captchaMonitor.watch = function () {
        if (SNIPER.captchaMonitor._watching) return;
        SNIPER.captchaMonitor._watching = true;

        SNIPER.captchaMonitor._observer = new MutationObserver((mutations) => {
            mutations.forEach(m => {
                m.addedNodes.forEach(node => {
                    if (node.nodeType !== 1) return;
                    // 检测验证码相关元素
                    const captchaSelectors = [
                        '.captcha', '#captcha', '[class*="captcha"]',
                        '[class*="verify"]', '[id*="captcha"]',
                        'img[src*="captcha"]', 'img[src*="verify"]',
                        '.slider-captcha', '.geetest', '.yidun',
                        'canvas[class*="captcha"]',
                    ];
                    let captchaEl = null;
                    for (const sel of captchaSelectors) {
                        captchaEl = node.matches?.(sel) ? node : node.querySelector?.(sel);
                        if (captchaEl) break;
                    }
                    if (captchaEl) {
                        SNIPER.warn('⚠️ 检测到验证码! 请手动完成验证');
                        SNIPER.updateStatus('running', '⚠️ 请手动完成验证码!');
                        // 高亮验证码区域
                        captchaEl.style.outline = '3px solid #ff6b6b';
                        captchaEl.style.animation = 'glm-flash 0.5s infinite alternate';
                        // 播放提示音
                        try {
                            const ctx = new (window.AudioContext || window.webkitAudioContext)();
                            const osc = ctx.createOscillator();
                            const gain = ctx.createGain();
                            osc.connect(gain); gain.connect(ctx.destination);
                            osc.frequency.value = 600;
                            osc.type = 'square';
                            gain.gain.value = 0.3;
                            osc.start(); osc.stop(ctx.currentTime + 0.3);
                        } catch(e) {}
                        // 浏览器通知
                        if (typeof GM_notification === 'function') {
                            GM_notification({
                                title: '需要验证码!',
                                text: 'GLM 抢购助手检测到验证码，请手动完成',
                                timeout: 5000,
                            });
                        }
                    }
                });
            });
        });

        SNIPER.captchaMonitor._observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });

        SNIPER.debug('验证码监控已启动');
    };

    SNIPER.captchaMonitor.stop = function () {
        if (SNIPER.captchaMonitor._observer) {
            SNIPER.captchaMonitor._observer.disconnect();
            SNIPER.captchaMonitor._observer = null;
        }
        SNIPER.captchaMonitor._watching = false;
    };
```

- [ ] **Step 2: 检查语法**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 3: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "feat: add payment dialog recovery (4-layer) and captcha monitor"
```

---

### Task 9: 集成连接 — 绑定所有模块

**Files:**
- Modify: `glm-coding-sniper.user.js`

**Interfaces:**
- Consumes: 所有模块
- Produces: `SNIPER.startMonitoring()`, `SNIPER.rushNow()`, `SNIPER.reset()`, 键盘快捷键

- [ ] **Step 1: 在文件末尾 `})();` 之前，添加集成方法**

```javascript
    // ============ 集成方法 ============

    // 开始监控（定时模式）
    SNIPER.startMonitoring = async function () {
        if (STATE.status === 'running') {
            SNIPER.warn('已在运行中');
            return;
        }
        // 确保拦截器已安装
        if (!SNIPER.intercept._active) {
            SNIPER.intercept.install();
        }
        // 确保有请求参数
        if (!STATE.capturedParams) {
            SNIPER.warn('尚未捕获请求参数，请先在页面点击一次购买按钮');
            SNIPER.updateStatus('idle', '⚠️ 请先点击购买按钮以捕获参数，再点「开始监控」');
            return;
        }
        // 校准时间
        await SNIPER.timer.calibrate();
        // 启动验证码监控
        SNIPER.captchaMonitor.watch();
        // 设置定时器
        SNIPER.timer.schedule(SNIPER.config.triggerTime, () => {
            SNIPER.engine.start();
        });
        SNIPER.updateStatus('monitoring', `🟡 监控中，目标时间: ${SNIPER.config.triggerTime}`);
    };

    // 立即抢购
    SNIPER.rushNow = function () {
        if (STATE.status === 'running') {
            SNIPER.warn('已在运行中');
            return;
        }
        if (!SNIPER.intercept._active) {
            SNIPER.intercept.install();
        }
        // 同步校准时间
        SNIPER.timer.calibrate().then(() => {
            SNIPER.captchaMonitor.watch();
            SNIPER.engine.start();
        });
    };

    // 重置
    SNIPER.reset = function () {
        SNIPER.engine.stop();
        SNIPER.timer.cancel();
        SNIPER.captchaMonitor.stop();
        STATE.capturedParams = null;
        STATE.retryCount = 0;
        STATE.bizId = null;
        STATE.status = 'idle';
        SNIPER.updateStatus('idle', '🟢 等待操作...');
        SNIPER.info('已重置');
    };

    // 请求通知权限
    SNIPER.requestNotificationPermission = function () {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(perm => {
                SNIPER.info(`通知权限: ${perm}`);
            });
        }
    };

    // ============ 键盘快捷键 ============
    document.addEventListener('keydown', function (e) {
        if (!e.altKey) return;
        switch (e.key.toLowerCase()) {
            case 's':
                e.preventDefault();
                SNIPER.startMonitoring();
                break;
            case 'x':
                e.preventDefault();
                SNIPER.reset();
                break;
            case 'h':
                e.preventDefault();
                const host = SNIPER.ui._dom && SNIPER.ui._dom.host;
                if (host) {
                    host.style.display = host.style.display === 'none' ? '' : 'none';
                    SNIPER.debug('切换面板显示');
                }
                break;
        }
    });

    // ============ 初始化 ============
    function init() {
        // 1. 安装拦截器（在 document-start 时，documentElement 可能尚未就绪）
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                SNIPER.intercept.install();
                SNIPER.antidetect.install();
            });
        } else {
            SNIPER.intercept.install();
            SNIPER.antidetect.install();
        }

        // 2. 等页面加载完成后初始化 UI
        window.addEventListener('load', () => {
            SNIPER.ui.init();
            SNIPER.requestNotificationPermission();
            // 延迟扫描套餐，等 Vue/React 渲染完成
            setTimeout(() => SNIPER.scanPlans(), 2000);
            setTimeout(() => SNIPER.scanPlans(), 5000);
            SNIPER.info('✅ GLM 抢购助手已就绪，配置套餐后点击「开始监控」或「立即抢购」');
        });
    }

    init();
})();
```

- [ ] **Step 2: 检查语法并做最终验证**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 3: 安装到 Tampermonkey，完整测试**

```
测试清单:
1. 打开 bigmodel.cn/glm-coding → 面板出现右下角
2. 套餐扫描有结果
3. 修改配置保存后刷新，配置保持
4. 点击页面购买按钮 → Console 显示参数捕获
5. 点击「立即抢购」→ 并发引擎启动
6. Alt+S 开始监控, Alt+X 停止, Alt+H 隐藏面板
```

- [ ] **Step 4: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "feat: integrate all modules, add keyboard shortcuts and init flow"
```

---

### Task 10: 最终打磨 — 样式美化 & 边界处理

**Files:**
- Modify: `glm-coding-sniper.user.js`

- [ ] **Step 1: 添加 CSS 动画和顶部横幅通知样式**

```javascript
// 在 shadow style 的闭合 </style> 之前添加:
`
    @keyframes glm-flash {
        from { outline-color: #ff6b6b; }
        to { outline-color: #ffe66d; }
    }
    @keyframes glm-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(255,107,107,0.4); }
        50% { box-shadow: 0 0 0 8px rgba(255,107,107,0); }
    }
    .btn-primary.running {
        animation: glm-pulse 1.5s infinite;
    }
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }
`
```

- [ ] **Step 2: 添加引擎运行时按钮状态反馈**

```javascript
// 在 SNIPER.engine.start() 中添加:
if (SNIPER.ui._dom && SNIPER.ui._dom.btnRush) {
    SNIPER.ui._dom.btnRush.classList.add('running');
    SNIPER.ui._dom.btnRush.textContent = '⏳ 抢购中...';
}

// 在 SNIPER.engine.stop() 和 _onSuccess 中添加:
if (SNIPER.ui._dom && SNIPER.ui._dom.btnRush) {
    SNIPER.ui._dom.btnRush.classList.remove('running');
    SNIPER.ui._dom.btnRush.textContent = '⚡ 立即抢购';
}
```

- [ ] **Step 3: 添加页面上方横幅通知条**

```javascript
SNIPER.ui.showBanner = function (msg, type = 'info') {
    const banner = document.createElement('div');
    banner.style.cssText = `
        position:fixed;top:0;left:0;right:0;z-index:9999999;
        padding:12px 24px;text-align:center;font-size:14px;font-weight:bold;
        animation:glm-slide 0.3s ease;
        color:#fff;
        background:${type === 'success' ? 'linear-gradient(90deg,#11998e,#38ef7d)'
            : type === 'error' ? 'linear-gradient(90deg,#cb2d3e,#ef473a)'
            : 'linear-gradient(90deg,#ff6b6b,#ee5a24)'};
    `;
    banner.textContent = msg;
    document.body.appendChild(banner);
    setTimeout(() => {
        banner.style.transform = 'translateY(-100%)';
        banner.style.transition = 'transform 0.3s ease';
        setTimeout(() => banner.remove(), 300);
    }, 4000);
};
```

- [ ] **Step 4: 最终语法检查**

```bash
node --check glm-coding-sniper.user.js
```

- [ ] **Step 5: Commit**

```bash
git add glm-coding-sniper.user.js
git commit -m "polish: add animations, button state feedback, top banner notification"
```

---

## 依赖性顺序

```
Task 1 (骨架) → Task 2 (日志/存储)
                    ↓
Task 3 (UI面板) ←──┘
                    ↓
Task 4 (拦截器) → Task 5 (反检测)
                    ↓
Task 6 (并发引擎) → Task 7 (定时器)
                    ↓
Task 8 (支付恢复/验证码)
                    ↓
Task 9 (集成) → Task 10 (打磨)
```
