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

    // ============ 请求拦截器 ============
    SNIPER.intercept = {
        _origJSONParse: JSON.parse,
        _origFetch: window.fetch,
        _origXHRSend: XMLHttpRequest.prototype.send,
        _origXHROpen: null,
        _origJSONParseToString: null,
        _origFetchToString: null,
        _origXHRSendToString: null,
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
        self._origJSONParseToString = JSON.parse.toString;
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
        self._origFetchToString = window.fetch.toString;
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

            // JSON.parse is already hijacked globally, so response patching
            // happens automatically when the caller parses the response body.
            return self._origFetch.call(window, input, init);
        };
        window.fetch.toString = function () { return 'function fetch() { [native code] }'; };
    };

    // XMLHttpRequest 劫持
    SNIPER.intercept._hijackXHR = function () {
        const self = SNIPER.intercept;
        self._origXHRSendToString = XMLHttpRequest.prototype.send.toString;
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
                if (xhr.readyState === 4 && (xhr.responseType === '' || xhr.responseType === 'text')) {
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
        self._origXHROpen = origOpen;
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
        const self = SNIPER.intercept;
        JSON.parse = self._origJSONParse;
        if (self._origJSONParseToString) {
            JSON.parse.toString = self._origJSONParseToString;
        }
        window.fetch = self._origFetch;
        if (self._origFetchToString) {
            window.fetch.toString = self._origFetchToString;
        }
        XMLHttpRequest.prototype.send = self._origXHRSend;
        if (self._origXHRSendToString) {
            XMLHttpRequest.prototype.send.toString = self._origXHRSendToString;
        }
        if (self._origXHROpen) {
            XMLHttpRequest.prototype.open = self._origXHROpen;
        }
        self._observers.forEach(o => o.disconnect());
        self._observers = [];
        self._active = false;
        SNIPER.warn('拦截器已卸载');
    };

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

        // 触发支付弹窗恢复 (Task 8 将添加 paymentRecovery 模块)
        if (SNIPER.paymentRecovery) SNIPER.paymentRecovery.attempt(bizId);
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
                transition: transform 0.2s, box-shadow 0.2s;
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
                    <div data-placeholder style="color:#555;">日志输出...</div>
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

        const onMouseMove = function (e) {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            host.style.right = 'auto';
            host.style.bottom = 'auto';
            host.style.left = (origX + dx) + 'px';
            host.style.top = (origY + dy) + 'px';
        };

        const onMouseUp = function () {
            dragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        header.addEventListener('mousedown', (e) => {
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = host.getBoundingClientRect();
            origX = rect.left;
            origY = rect.top;
            e.preventDefault();
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    };

    SNIPER.ui.createToggleButton = function () {
        // 检查是否已存在，避免重复创建
        if (document.getElementById('glm-sniper-toggle')) return;
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
        // 首次真实日志时清除占位符
        const placeholder = logArea.querySelector('[data-placeholder]');
        if (placeholder) placeholder.remove();
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
        const addedOptions = new Set();
        // 记录已有 option 的 value，避免重复添加
        for (const opt of sel.options) { addedOptions.add(opt.value); }
        try {
            document.querySelectorAll(buyBtnSelectors).forEach(btn => {
                const text = btn.textContent.trim();
                if (text.includes('购买') || text.includes('订阅') || text.includes('抢购')) {
                    const parentText = btn.closest('div,section,li')?.textContent?.trim()?.substring(0, 50);
                    if (parentText) {
                        for (const name of knownPlans) {
                            if (parentText.includes(name) && !addedOptions.has(name)) {
                                plans.add(name);
                                addedOptions.add(name);
                                const opt = document.createElement('option');
                                opt.value = name;
                                opt.textContent = name + ' (从按钮识别)';
                                sel.appendChild(opt);
                            }
                        }
                    }
                }
            });
        } catch (e) { /* ignore button-recognition errors */ }

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

    console.log('[GLM抢购] 脚本已注入 (v1.0.0)');
})();
