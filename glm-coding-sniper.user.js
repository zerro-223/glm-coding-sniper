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

    // 发送单个 preview 请求（带 AbortController + 10s 超时）
    SNIPER.engine._sendPreview = function (controller) {
        if (!STATE.capturedParams) {
            return Promise.reject(new Error('无捕获的请求参数'));
        }
        const params = STATE.capturedParams;
        const headers = {
            'Content-Type': 'application/json',
            ...SNIPER.antidetect.randomizeHeaders(),
        };
        // 单请求超时：10 秒无响应则 abort，防止挂起阻塞 race
        const timeoutId = setTimeout(() => controller.abort(), 10000);
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
        }).finally(() => clearTimeout(timeoutId));
    };

    // check 校验 bizId（遍历 fallback URL）
    SNIPER.engine._checkBizId = function (bizId) {
        const baseUrl = STATE.capturedParams ? STATE.capturedParams.url : '';
        const checkUrls = [
            baseUrl.replace(/preview/gi, 'check'),
            baseUrl.replace(/preview/gi, 'verify'),
            '/api/check',
            '/api/order/check',
        ];

        // 递归尝试：每个 URL 依次尝试，网络错误则 fallback 到下一个
        const tryCheck = (index) => {
            if (index >= checkUrls.length) {
                SNIPER.warn('所有 check 端点均不可达，乐观认为有效');
                return Promise.resolve({ valid: true, data: {} });
            }
            const checkUrl = checkUrls[index];
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
            }).catch(err => {
                SNIPER.debug(`check URL [${index}] 失败: ${err.message}，尝试下一个`);
                return tryCheck(index + 1);
            });
        };

        return tryCheck(0);
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
                    SNIPER.updateStatus('success', '抢购成功! 请立即扫码支付');
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

            // 可中断等待：每 50ms 检查 _running，stop() 可即时生效
            if (interval > 0 && SNIPER.engine._running) {
                const end = Date.now() + interval;
                while (SNIPER.engine._running && Date.now() < end) {
                    await new Promise(r => setTimeout(r, Math.min(50, end - Date.now())));
                }
            }
        }

        if (STATE.retryCount >= cfg.maxRetries) {
            SNIPER.warn('达到最大重试次数');
        }
        if (SNIPER.engine._running) {
            SNIPER.updateStatus('failed', '抢购未成功');
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

        // 页面上方横幅通知
        SNIPER.ui.showBanner(`✅ 抢购成功! bizId: ${bizId}，请立即支付`, 'success');

        // 恢复按钮状态
        if (SNIPER.ui._dom && SNIPER.ui._dom.btnRush) {
            SNIPER.ui._dom.btnRush.classList.remove('running');
            SNIPER.ui._dom.btnRush.textContent = '⚡ 立即抢购';
        }

        // 触发支付弹窗恢复
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
        SNIPER.updateStatus('running', '抢购中...');

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

        // 按钮状态反馈
        if (SNIPER.ui._dom && SNIPER.ui._dom.btnRush) {
            SNIPER.ui._dom.btnRush.classList.add('running');
            SNIPER.ui._dom.btnRush.textContent = '⏳ 抢购中...';
        }
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

        // 恢复按钮状态
        if (SNIPER.ui._dom && SNIPER.ui._dom.btnRush) {
            SNIPER.ui._dom.btnRush.classList.remove('running');
            SNIPER.ui._dom.btnRush.textContent = '⚡ 立即抢购';
        }
    };

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
        SNIPER.updateStatus('monitoring', `监控中，目标时间: ${timeStr}`);

        const tick = () => {
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
                (function () {
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
                })();
                setTimeout(() => SNIPER.paymentRecovery._checkAndRetry(bizId), 1000);
                break;

            case 2:
                // 第3层：直接请求支付链接
                (function () {
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
                })();
                setTimeout(() => SNIPER.paymentRecovery._checkAndRetry(bizId), 2000);
                break;

            case 3:
                // 第4层：Vue 组件树兜底
                SNIPER.paymentRecovery._vuePatch();
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

    SNIPER.paymentRecovery._vuePatch = function () {
        SNIPER.debug('尝试 Vue 组件树兜底...');
        // 遍历所有 DOM 元素的 Vue 实例引用
        const walk = function (el) {
            const vue = el.__vue__ || el.__vue_app__ || el._vueInstance;
            if (vue) {
                SNIPER.paymentRecovery._patchVue(vue);
            }
            if (el.childNodes) {
                el.childNodes.forEach(walk);
            }
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

    SNIPER.paymentRecovery._patchVue = function (vue) {
        try {
            if (vue.payDialogVisible !== undefined) {
                vue.payDialogVisible = true;
                SNIPER.debug('设置 payDialogVisible = true');
            }
            if (vue.isServerBusy !== undefined) {
                vue.isServerBusy = false;
                SNIPER.debug('设置 isServerBusy = false');
            }
            if (vue.paymentVisible !== undefined) {
                vue.paymentVisible = true;
                SNIPER.debug('设置 paymentVisible = true');
            }
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
                        captchaEl = node.matches && node.matches(sel) ? node : node.querySelector && node.querySelector(sel);
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
                        } catch (e) { /* ignore */ }
                        // 浏览器通知
                        if (typeof GM_notification === 'function') {
                            GM_notification({
                                title: '需要验证码!',
                                text: 'GLM 抢购助手检测到验证码，请手动完成',
                                timeout: 5000,
                            });
                        } else if ('Notification' in window && Notification.permission === 'granted') {
                            new Notification('需要验证码!', {
                                body: 'GLM 抢购助手检测到验证码，请手动完成',
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

    // ============ 控制面板 UI ============
    SNIPER.ui = {};

    SNIPER.ui.createPanel = function () {
        // 创建 Shadow DOM 宿主
        const host = document.createElement('div');
        host.id = 'glm-sniper-host';
        host.style.cssText = 'position:fixed;z-index:999999;right:12px;bottom:12px;';
        document.documentElement.appendChild(host);

        const shadow = host.attachShadow({ mode: 'closed' });

        // 内联样式 — 暗玻璃设计系统
        const style = document.createElement('style');
        style.textContent = `
            :host {
                --glass-bg:       rgba(18, 18, 30, 0.74);
                --glass-border:   rgba(255, 255, 255, 0.06);
                --glass-input:    rgba(255, 255, 255, 0.05);
                --glass-hover:    rgba(255, 255, 255, 0.08);
                --accent:         #ff6b6b;
                --accent-glow:    rgba(255, 107, 107, 0.25);
                --cta:            #ff6b6b;
                --cta-glow:       rgba(255, 107, 107, 0.30);
                --success:        #2ecc71;
                --warning:        #f59e0b;
                --text-primary:   #e8e8ed;
                --text-secondary: #9a9aaa;
                --text-muted:     #6b6b7d;
                --radius-sm:      6px;
                --radius-md:      10px;
                --radius-lg:      14px;
                --font-ui:        system-ui, -apple-system, 'Segoe UI', sans-serif;
                --font-mono:      'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', monospace;
            }
            * { box-sizing:border-box;margin:0;padding:0; }

            .panel {
                width: 280px;
                background: var(--glass-bg);
                color: var(--text-primary);
                border-radius: var(--radius-lg);
                box-shadow:
                    0 0 0 1px var(--glass-border),
                    0 8px 40px rgba(0,0,0,0.55);
                font-family: var(--font-ui);
                font-size: 12px;
                overflow: hidden;
                user-select: none;
                backdrop-filter: blur(20px) saturate(140%);
                -webkit-backdrop-filter: blur(20px) saturate(140%);
            }
            /* header */
            .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 10px 14px;
                cursor: move;
                border-bottom: 1px solid var(--glass-border);
                position: relative;
            }
            /* 顶部折射光条 */
            .header::after {
                content: '';
                position: absolute;
                left: 0; top: 0; right: 0;
                height: 1px;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
            }
            .header-brand {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .header-icon {
                width: 26px; height: 26px;
                border-radius: 6px;
                background: linear-gradient(135deg, #ff6b6b, #ee5a24);
                display: flex; align-items: center; justify-content: center;
                font-size: 14px;
            }
            .header h3 {
                font-size: 13px;
                font-weight: 600;
                color: var(--text-primary);
                letter-spacing: -0.01em;
            }
            .header h3 span { color: var(--accent); }
            .header-btns { display:flex;gap:4px; }
            .header-btns button {
                background: transparent;
                border: 1px solid var(--glass-border);
                color: var(--text-muted);
                width: 24px; height: 24px;
                border-radius: var(--radius-sm);
                cursor: pointer;
                font-size: 11px;
                line-height: 1;
                transition: all 0.15s ease;
            }
            .header-btns button:hover {
                background: var(--glass-hover);
                color: var(--text-secondary);
                border-color: rgba(255,255,255,0.12);
            }
            /* body */
            .body { padding: 12px 14px; }
            /* rows */
            .row { display: flex; gap: 8px; align-items: center; margin-bottom: 7px; }
            .row label { flex: 0 0 40px; font-size: 11px; color: var(--text-secondary); white-space: nowrap; }
            .row-unit { font-size: 10px; color: var(--text-muted); flex-shrink: 0; min-width: 16px; }
            select, input[type="text"] {
                flex: 1; min-width: 0;
                background: var(--glass-input);
                border: 1px solid var(--glass-border);
                border-radius: var(--radius-sm);
                color: var(--text-primary);
                padding: 6px 8px;
                font-size: 11px;
                font-family: var(--font-ui);
                outline: none;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            select:focus, input:focus {
                border-color: var(--accent);
                box-shadow: 0 0 0 3px var(--accent-glow);
            }
            select {
                cursor: pointer; appearance: none;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b6b7d'/%3E%3C/svg%3E");
                background-repeat: no-repeat;
                background-position: right 8px center;
                padding-right: 24px;
            }
            select option { background: #181820; color: var(--text-primary); }
            input[type="number"] {
                flex: 1; max-width: 56px; min-width: 0; text-align: center;
                background: var(--glass-input);
                border: 1px solid var(--glass-border);
                border-radius: var(--radius-sm);
                color: var(--text-primary);
                padding: 6px 4px;
                font-size: 11px;
                font-family: var(--font-mono);
                outline: none;
                -moz-appearance: textfield;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            input[type="number"]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
            input[type="number"]::-webkit-inner-spin-button,
            input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; }
            /* status bar */
            .status-bar {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 12px;
                background: var(--glass-input);
                border-radius: var(--radius-md);
                margin-bottom: 10px;
                font-size: 11px;
                font-family: var(--font-mono);
                border: 1px solid var(--glass-border);
                transition: border-color 0.3s ease;
            }
            .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
            .status-bar.idle    { border-color: rgba(255,255,255,0.06); }
            .status-bar.idle    .status-dot { background: #52525b; }
            .status-bar.monitoring { border-color: var(--warning); }
            .status-bar.monitoring .status-dot {
                background: var(--warning);
                animation: dot-pulse 1.5s ease-in-out infinite;
            }
            .status-bar.running  { border-color: var(--accent); }
            .status-bar.running  .status-dot {
                background: var(--accent);
                animation: dot-pulse 0.8s ease-in-out infinite;
            }
            .status-bar.success  { border-color: var(--success); }
            .status-bar.success  .status-dot { background: var(--success); }
            .status-bar.failed   { border-color: #ef4444; }
            .status-bar.failed   .status-dot { background: #ef4444; }
            @keyframes dot-pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50%      { opacity: 0.4; transform: scale(0.7); }
            }
            /* log area */
            .log-area {
                background: var(--glass-input);
                border: 1px solid var(--glass-border);
                border-radius: var(--radius-md);
                padding: 6px 10px;
                max-height: 40px;
                overflow-y: auto;
                font-size: 10px;
                font-family: var(--font-mono);
                line-height: 1.5;
                margin-bottom: 10px;
            }
            .log-entry { padding: 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .log-entry .t { color: var(--text-muted); margin-right: 6px; }
            .log-entry.DEBUG   { color: var(--text-muted); }
            .log-entry.INFO    { color: var(--text-secondary); }
            .log-entry.WARN    { color: var(--warning); }
            .log-entry.ERROR   { color: #f87171; }
            .log-entry.SUCCESS { color: var(--success); }
            /* buttons */
            .btn-row { display:flex;gap:7px;flex-wrap:wrap; }
            .btn-row .btn { flex: 1; }
            .btn {
                padding: 8px 10px;
                border: 1px solid transparent;
                border-radius: var(--radius-sm);
                cursor: pointer;
                font-size: 11px;
                font-weight: 600;
                font-family: var(--font-ui);
                letter-spacing: 0.01em;
                transition: all 0.2s ease;
                text-align: center;
            }
            .btn:active { transform: scale(0.97); }
            .btn-primary {
                background: var(--glass-input);
                color: var(--text-primary);
                border-color: var(--glass-border);
            }
            .btn-primary:hover {
                background: var(--glass-hover);
                border-color: var(--accent);
                color: var(--accent);
                box-shadow: 0 0 16px var(--accent-glow);
            }
            .btn-rush {
                background: linear-gradient(135deg, #ff6b6b, #ee5a24);
                color: #fff;
                border-color: transparent;
                font-weight: 700;
                letter-spacing: 0.02em;
            }
            .btn-rush:hover {
                box-shadow: 0 0 20px var(--cta-glow), 0 4px 12px rgba(0,0,0,0.3);
                transform: translateY(-1px);
            }
            .btn-rush:active { transform: scale(0.97) translateY(0); }
            .btn-rush.running { animation: rush-glow 1.2s ease-in-out infinite; }
            @keyframes rush-glow {
                0%, 100% { box-shadow: 0 0 8px var(--cta-glow); }
                50%      { box-shadow: 0 0 24px var(--cta-glow), 0 0 48px rgba(255,107,107,0.1); }
            }
            .btn-secondary {
                background: transparent;
                color: var(--text-secondary);
                border-color: var(--glass-border);
            }
            .btn-secondary:hover {
                background: var(--glass-input);
                color: var(--text-primary);
                border-color: rgba(255,255,255,0.12);
            }
            /* collapsed */
            .minimized .body { display:none; }
            .minimized .header { border-bottom: none; }
            /* hint */
            .shortcut-hint {
                font-size: 9px; color: var(--text-muted); text-align: center;
                margin-top: 6px; font-family: var(--font-mono); opacity: 0.7;
            }
            .shortcut-hint kbd {
                display: inline-block;
                background: var(--glass-input);
                border: 1px solid var(--glass-border);
                border-radius: 3px;
                padding: 0 4px;
                font-family: var(--font-mono);
                font-size: 9px;
                color: var(--text-secondary);
            }
            @keyframes glm-flash {
                from { outline-color: #f87171; }
                to   { outline-color: var(--warning); }
            }
            ::-webkit-scrollbar { width: 4px; }
            ::-webkit-scrollbar-track { background: transparent; }
            ::-webkit-scrollbar-thumb { background: var(--glass-border); border-radius: 2px; }
            ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.12); }
        `;
        shadow.appendChild(style);

        // 面板 DOM
        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.innerHTML = `
            <div class="header" id="panel-header">
                <div class="header-brand">
                    <div class="header-icon">🎯</div>
                    <h3>GLM<span>·抢购</span></h3>
                </div>
                <div class="header-btns">
                    <button id="btn-min" title="最小化">─</button>
                    <button id="btn-close" title="关闭面板">✕</button>
                </div>
            </div>
            <div class="body" id="panel-body">
                <div class="section">
                    <div class="section-header">
                        <span class="section-dot plan"></span>
                        <span class="section-label">套餐设置</span>
                    </div>
                    <div class="row">
                        <label>目标套餐</label>
                        <select id="sel-plan">
                            <option value="">自动检测</option>
                        </select>
                    </div>
                    <div class="row">
                        <label>付费周期</label>
                        <select id="sel-cycle">
                            <option value="monthly">连续包月</option>
                            <option value="quarterly">连续包季 (9折)</option>
                            <option value="yearly">连续包年 (8折)</option>
                        </select>
                    </div>
                </div>
                <div class="section">
                    <div class="section-header">
                        <span class="section-dot timer"></span>
                        <span class="section-label">定时设置</span>
                    </div>
                    <div class="row">
                        <label>开抢时间</label>
                        <input id="inp-time" type="text" value="${SNIPER.config.triggerTime}" placeholder="09:59:58">
                    </div>
                    <div class="row">
                        <label>提前触发</label>
                        <input id="inp-lead" type="number" value="${SNIPER.config.leadMs}" placeholder="200" step="10">
                        <span class="row-unit">ms</span>
                    </div>
                </div>
                <div class="section">
                    <div class="section-header">
                        <span class="section-dot concur"></span>
                        <span class="section-label">并发设置</span>
                    </div>
                    <div class="row">
                        <label>极速并发</label>
                        <input id="inp-turbo" type="number" value="${SNIPER.config.turboConcurrency}" min="1" max="20" step="1">
                        <span class="row-unit">路</span>
                    </div>
                    <div class="row">
                        <label>普通并发</label>
                        <input id="inp-normal" type="number" value="${SNIPER.config.normalConcurrency}" min="1" max="10" step="1">
                        <span class="row-unit">路</span>
                    </div>
                    <div class="row">
                        <label>最大重试</label>
                        <input id="inp-retries" type="number" value="${SNIPER.config.maxRetries}" min="10" max="10000" step="10">
                        <span class="row-unit">次</span>
                    </div>
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
                    <button class="btn btn-rush" id="btn-rush">⚡ 立即抢购</button>
                </div>
                <div class="btn-row" style="margin-top:7px;">
                    <button class="btn btn-secondary" id="btn-scan">扫描套餐</button>
                    <button class="btn btn-secondary" id="btn-reset">重置</button>
                </div>
                <div class="shortcut-hint">
                    <kbd>Alt</kbd>+<kbd>S</kbd> 开始 &nbsp; <kbd>Alt</kbd>+<kbd>X</kbd> 停止 &nbsp; <kbd>Alt</kbd>+<kbd>H</kbd> 隐藏
                </div>
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
        btn.innerHTML = '🎯';
        btn.style.cssText = `
            position:fixed;z-index:999999;right:12px;bottom:12px;
            width:38px;height:38px;border-radius:50%;
            background:linear-gradient(135deg,#8b5cf6,#a78bfa);
            color:#fff;font-size:16px;display:flex;
            align-items:center;justify-content:center;
            cursor:pointer;
            box-shadow:0 4px 16px rgba(139,92,246,0.35),0 2px 4px rgba(0,0,0,0.3);
            transition:transform 0.2s ease,box-shadow 0.2s ease;
        `;
        btn.title = '显示 GLM 抢购助手';
        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'scale(1.08)';
            btn.style.boxShadow = '0 6px 20px rgba(139,92,246,0.45),0 2px 4px rgba(0,0,0,0.3)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'scale(1)';
            btn.style.boxShadow = '0 4px 16px rgba(139,92,246,0.35),0 2px 4px rgba(0,0,0,0.3)';
        });
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
        bar.className = 'status-bar ' + status;
        const statusText = bar.querySelector('.status-text');
        if (statusText) {
            statusText.textContent = text || status;
        }
    };

    // 页面上方横幅通知
    SNIPER.ui.showBanner = function (msg, type) {
        type = type || 'info';
        const banner = document.createElement('div');
        banner.style.cssText = [
            'position:fixed;top:0;left:0;right:0;z-index:9999999;',
            'padding:12px 24px;text-align:center;font-size:13px;font-weight:600;',
            'font-family:system-ui,-apple-system,sans-serif;',
            'color:#fff;letter-spacing:0.02em;',
            'background:' + (type === 'success'
                ? 'linear-gradient(90deg,#059669,#10b981)'
                : type === 'error'
                    ? 'linear-gradient(90deg,#e11d48,#f43f5e)'
                    : 'linear-gradient(90deg,#8b5cf6,#a78bfa)') + ';',
            'box-shadow:0 2px 16px rgba(0,0,0,0.3);',
        ].join('');
        banner.textContent = msg;

        // 动画：从上方滑入
        banner.style.transform = 'translateY(-100%)';
        banner.style.transition = 'transform 0.3s ease';
        document.body.appendChild(banner);
        requestAnimationFrame(() => {
            banner.style.transform = 'translateY(0)';
        });

        // 4 秒后滑出移除
        setTimeout(() => {
            banner.style.transform = 'translateY(-100%)';
            setTimeout(() => banner.remove(), 300);
        }, 4000);
    };

    // 验证文本是否像合法的套餐名
    SNIPER._isValidPlanName = function (text) {
        if (!text || text.length > 12 || text.length < 2) return false;
        // 排除包含数字的
        if (/\d/.test(text)) return false;
        // 排除价格符号
        if (/[¥$]/.test(text)) return false;
        // 排除中文标点 → 说明是一句话
        if (/[，。！？、：；]/.test(text)) return false;
        // 排除折扣/促销/周期用语
        if (/[折减月年季]/.test(text)) return false;
        // 排除中英文混合（如 "Max量大管饱", "LiteMax"=无中文但属拼接，由策略2兜底）
        if (/[a-zA-Z]/.test(text) && /[一-鿿]/.test(text)) return false;
        // 排除 UI / 描述文本关键词
        if (/订阅|购买|抢购|支付|确认|下单|自动|扫描|套餐|检测/.test(text)) return false;
        if (/最受欢迎|推荐|热门|特惠|优惠|立减|拼好|新人|首充/.test(text)) return false;
        if (/额度|适合|支持|逐步|下个|续费|金额|团队|个人/.test(text)) return false;
        if (/元|原价|现价|限时|活动|体验|注册|常见|如何|开始|问题/.test(text)) return false;
        if (/可靠|交付|生产|代码|量大|管饱|卓越|模型/.test(text)) return false;
        return true;
    };

    // 扫描套餐
    SNIPER.scanPlans = function () {
        var sel = SNIPER.ui._dom && SNIPER.ui._dom.selPlan;
        if (!sel) return;
        var currentValue = sel.value;
        sel.innerHTML = '<option value="">自动检测...</option>';

        var plans = new Set();
        var knownPlans = ['Lite', 'Pro', 'Max'];

        // 策略1：在套餐卡片内查找标题元素
        var cardSelectors = [
            '.plan-card', '.package-item', '.product-card', '.pricing-card', '.price-card',
            '[class*="plan-card"]', '[class*="package-card"]', '[class*="pricing-card"]',
        ];
        cardSelectors.forEach(function (selector) {
            try {
                document.querySelectorAll(selector).forEach(function (card) {
                    var titleEl = card.querySelector(
                        'h1, h2, h3, h4, h5, h6, .title, .name, .heading, ' +
                        '.plan-name, .product-name, .package-name, ' +
                        '[class*="title"], [class*="name"], [class*="heading"]'
                    );
                    if (titleEl) {
                        var text = titleEl.textContent.trim().replace(/\s+/g, ' ');
                        var firstLine = text.split(/[，,]/)[0].trim();
                        if (SNIPER._isValidPlanName(firstLine)) {
                            plans.add(firstLine);
                        } else if (SNIPER._isValidPlanName(text)) {
                            plans.add(text);
                        }
                    }
                });
            } catch (e) { /* ignore */ }
        });

        // 策略2：只在 h2/h3 中匹配已知套餐名（精确或「名+分隔」开头）
        try {
            document.querySelectorAll('h2, h3, .plan-name, .product-name, [class*="plan-name"], [class*="product-name"]')
                .forEach(function (el) {
                    var text = el.textContent.trim().replace(/\s+/g, ' ');
                    for (var i = 0; i < knownPlans.length; i++) {
                        var name = knownPlans[i];
                        if (text === name || text.indexOf(name + ' ') === 0 || text.indexOf(name + '，') === 0) {
                            plans.add(name);
                            break;
                        }
                    }
                });
        } catch (e) { /* ignore */ }

        // 策略3：已知套餐名兜底（页面正文包含即添加）
        knownPlans.forEach(function (name) {
            if (document.body.innerText.indexOf(name) !== -1) {
                plans.add(name);
            }
        });

        // 过滤占位文本
        plans.delete('自动检测');
        plans.delete('');

        // 填充下拉框
        var sorted = Array.from(plans).sort();
        sorted.forEach(function (plan) {
            var opt = document.createElement('option');
            opt.value = plan;
            opt.textContent = plan;
            if (plan === currentValue) opt.selected = true;
            sel.appendChild(opt);
        });

        var count = sel.options.length - 1;
        SNIPER.info('扫描完成，发现 ' + count + ' 个套餐');
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
        SNIPER.updateStatus('monitoring', `监控中，目标时间: ${SNIPER.config.triggerTime}`);
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
        if (!STATE.capturedParams) {
            SNIPER.warn('请先在页面点击一次购买按钮以捕获参数');
            SNIPER.updateStatus('idle', '⚠️ 请先点击购买按钮');
            return;
        }
        // 异步校准时间，校准完成后启动
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
        SNIPER.updateStatus('idle', '等待操作');
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

    // 恢复支付弹窗 (从引擎成功回调触发)
    SNIPER.recoverPayment = function (bizId) {
        SNIPER.paymentRecovery.attempt(bizId);
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
                (function () {
                    const host = SNIPER.ui._dom && SNIPER.ui._dom.host;
                    if (host) {
                        if (host.style.display === 'none') {
                            host.style.display = '';
                            // 移除浮动按钮
                            const toggle = document.getElementById('glm-sniper-toggle');
                            if (toggle) toggle.remove();
                        } else {
                            host.style.display = 'none';
                            SNIPER.ui._showToggle = SNIPER.ui.createToggleButton();
                        }
                        SNIPER.debug('切换面板显示');
                    }
                })();
                break;
        }
    });

    // ============ 启动 ============
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
    console.log('[GLM抢购] 脚本已注入 (v1.0.0)');
})();
