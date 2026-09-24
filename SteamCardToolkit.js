// ==UserScript==
// @name         SteamCardToolkit
// @namespace    https://github.com/QuillonSong/SteamCardToolkit
// @version      1.7.1
// @description  API 直读库存与市场价，按市场最低价批量上架集换式卡牌（手机端批量确认）
// @author       Quillon
// @license      GPL-3.0-only
// @homepageURL  https://github.com/QuillonSong/SteamCardToolkit
// @supportURL   https://github.com/QuillonSong/SteamCardToolkit/issues
// @updateURL    https://raw.githubusercontent.com/QuillonSong/SteamCardToolkit/main/SteamCardToolkit.js
// @downloadURL  https://raw.githubusercontent.com/QuillonSong/SteamCardToolkit/main/SteamCardToolkit.js
// @match        https://steamcommunity.com/id/*/inventory*
// @match        https://steamcommunity.com/profiles/*/inventory*
// @match        https://steamcommunity.com/market/*
// @match        https://steamcommunity.com/market/
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ========================================================================
    // 一、配置
    // ========================================================================

    const CONFIG = {
        // 目标应用：753 = Steam 社区物品（集换式卡牌、表情、背景等都在这里）
        APPID: 753,
        // 目标上下文：6 = 社区。1 是"礼物"，不参与市场交易
        CONTEXTID: 6,

        // 单次拉取的资产上限。实测库存 433 件，2000 足够覆盖且不会显著拖慢响应
        INVENTORY_FETCH_COUNT: 2000,

        // 价格查询间隔（毫秒）。Steam 对 priceoverview 端点有限流，
        // 实测 1300ms 稳定，这里留出余量取 1500
        PRICE_QUERY_INTERVAL: 1500,

        // 上架发起间隔（毫秒）。sellitem 是未公开端点，
        // 批量高频调用有触发风控的风险，因此比查价更保守
        SELL_INTERVAL: 1200,

        // 内存中价格缓存的有效期（毫秒）。同一次会话内，同一 market_hash_name
        // 在这个时间内只查一次，避免重复请求
        PRICE_CACHE_TTL: 5 * 60 * 1000,

        // 持久化价格缓存的有效期（毫秒）。存进 localStorage，让"下次打开页面"
        // 也能复用上次查到的价格，不必重新等一轮。
        // 取 2 小时是折中：低价卡价格短期内相当稳定，但也不该拿太旧的数据做决策
        PRICE_CACHE_PERSIST_TTL: 2 * 60 * 60 * 1000,

        // localStorage 中存放价格缓存的键名
        PRICE_CACHE_KEY: 'scbs:pricecache',

        // 每查多少条把持久缓存落盘一次。
        // 逐条写会在 260 次 JSON 序列化上白费时间，完全拖到最后写又会在中途关页面时丢光结果
        PRICE_CACHE_FLUSH_EVERY: 20,

        // 每次上架操作最多发起多少笔，发满后停下等用户去手机确认。
        // 设成 0 表示不限制。默认小批量是为了避免一次堆出上百条待确认把人埋了
        SELL_BATCH_SIZE: 30,

        PANEL_ID: 'steam-card-batch-seller',
        STYLE_ID: 'steam-card-batch-seller-style',
    };

    // ========================================================================
    // 二、运行时状态
    // ========================================================================

    const state = {
        /** 全量物品条目（asset 级），元素结构见 InventoryAPI.buildItems */
        items: [],
        /**
         * 按 market_hash_name 合并后的分组（展示用）。
         * 为什么要多这一层：重复卡各占一行会让列表被同一张卡刷屏，
         * 合并成"Charger X3"更利于判断该卖什么。
         * 但上架仍要落到 asset 级 —— Steam 的上架接口是单个 asset 的
         */
        groups: [],
        /** 勾选状态：assetid -> true。用 Set 而非挂在 DOM 上，避免重渲染丢状态 */
        selected: new Set(),
        /** 价格缓存：market_hash_name -> { lowestCents, youReceiveCents, ts } */
        priceCache: new Map(),
        /**
         * 最近一次查询的失败原因：market_hash_name -> 'limit' | 'error'。
         * 为什么要单独记：被限流和"真没人卖"在界面上必须能区分开，
         * 否则用户会把限流误读成"这卡不值钱"，据此做出错误的上架决策。
         */
        priceErrors: new Map(),
        /** 列表是否已加载 */
        loaded: false,
        /** 是否有耗时任务在跑，用于互斥，防止用户连点造成并发请求风暴 */
        busy: false,
        /** 当前筛选：'card' | 'foil' | 'all' */
        filter: 'card',
        /**
         * 是否启用「仅重复」：开启后每组只卖多余的，且没有多余的卡直接从列表隐藏。
         * 注意它和 filter 是两个独立维度 —— 前者管"卖多少"，后者管"看哪些"
         */
        repeatOnly: false,
        /**
         * 「仅重复」开启时每组保留几张（其余卖掉）。
         * 例：某卡有 6 张、保留 4 张 → 列表显示 X2（要卖 2 张）。
         * 所以开启后徽标显示的是"要卖几张"，而不是"共有几张"
         */
        keepCount: 1,
        /**
         * 上架定价规则：
         *   'lowest'  直接用市场最低价
         *   'fixed'   最低价 + 固定金额（元）
         *   'percent' 最低价 × (1 + N%)
         */
        priceRule: 'lowest',
        /** 固定附加金额，单位元。解析后转成分参与计算 */
        fixedOffsetYuan: '',
        /** 百分比附加值。填 1 表示 +1% */
        percentOffset: '',
    };

    // ========================================================================
    // 三、基础工具
    // ========================================================================

    const UI = {
        log(message, ...args) {
            console.log(`[卡牌上架] ${message}`, ...args);
        },
        warn(message, ...args) {
            console.warn(`[卡牌上架] ${message}`, ...args);
        },
        error(message, ...args) {
            console.error(`[卡牌上架] ${message}`, ...args);
        },
    };

    /** 等待若干毫秒。限速全靠它，所有对外请求之间都要过这个 */
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * HTML 转义。
     * 物品名来自 Steam API，虽然可控，但列表是用 innerHTML 拼的，
     * 一旦名字里出现尖括号就会破坏结构，因此必须转义。
     */
    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * 取当前登录用户的 steamid。
     * 优先用页面的 g_steamID（最权威）；退化到从 URL 里刮。
     * 注意：新版库存页 URL 可能是 /inventory/ 而不带 id，此时只能靠 g_steamID。
     */
    function getSteamId() {
        try {
            if (typeof g_steamID !== 'undefined' && g_steamID) return g_steamID;
        } catch (e) { /* 主世界里正常不会抛，防御性处理 */ }
        // 退化：从 URL 里刮。坑位：/id/xxx 拿到的是 vanity name 而不是数字 ID，
        // 库存接口虽然通常也认，但可靠性不如 g_steamID，因此记一条警告便于排查
        const m = location.pathname.match(/\/(id|profiles)\/([^/]+)/);
        if (m) {
            UI.warn(`未能取到 g_steamID，退化使用 URL 中的 "${m[2]}"，可能不准确`);
            return m[2];
        }
        return null;
    }

    /**
     * 面板折叠状态的持久化。
     * 为什么存 localStorage：面板是常驻的，用户把它收成小标签的意图是"别挡着我"，
     * 这个意图应该在刷新后依然成立，否则每开一次页面都要手动收一次。
     * try/catch 是必须的 —— 隐私模式或站点数据被禁用时 localStorage 会直接抛异常。
     */
    const COLLAPSE_KEY = 'scbs:collapsed';

    function readCollapsedPref() {
        try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { return false; }
    }

    function writeCollapsedPref(collapsed) {
        try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) { /* 写不进去不影响功能 */ }
    }

    /**
     * 面板位置的持久化。
     *
     * 为什么要分展开态和折叠态各记一份：两者宽度差一个数量级
     * （420px vs 30px 上下），共用一份位置会导致切换形态时面板大幅跳位。
     * 折叠态只记「贴哪一边 + 纵向位置」而不是绝对坐标 —— 这样窗口大小变化时
     * 重新按边计算即可，不会因为存的是旧宽度下的 left 而跑到屏幕外。
     */
    const POS_KEY = 'scbs:pos';

    function readPosPref() {
        try {
            const raw = localStorage.getItem(POS_KEY);
            const obj = raw ? JSON.parse(raw) : null;
            return (obj && typeof obj === 'object') ? obj : null;
        } catch (e) { return null; }
    }

    function writePosPref(pref) {
        try { localStorage.setItem(POS_KEY, JSON.stringify(pref)); } catch (e) { /* 同上 */ }
    }

    /**
     * 视口可用宽高（不含滚动条）。
     *
     * 这里刻意不用 window.innerWidth —— 它把垂直滚动条的宽度也算在视口内，
     * 拿它算"贴右边缘"会让面板右缘落在滚动条底下，被遮住十几像素。
     * documentElement.clientWidth 才是真正能放内容的宽度。
     *
     * 同理也不用它作兜底：本文件其余位置的视口计算已全部改为调用这两个函数，
     * 若在此处写 window.innerWidth，全局替换后会变成对自身的调用。
     */
    function viewportWidth() {
        const d = document.documentElement;
        return d.clientWidth || (document.body && document.body.clientWidth) || 0;
    }

    function viewportHeight() {
        const d = document.documentElement;
        return d.clientHeight || (document.body && document.body.clientHeight) || 0;
    }

    /** 纵向边界钳制：不允许把面板拖到视口外，否则就再也点不到了 */
    function clampTop(top, height) {
        const max = Math.max(0, viewportHeight() - height);
        return Math.max(0, Math.min(top, max));
    }

    /**
     * 面板拖动。
     *
     * 与"点击"的冲突：折叠态下整个标签是可点的（点开面板），现在又要能拖它。
     * 用位移阈值区分 —— 按下后移动超过 4px 才算拖动，否则仍按点击处理。
     */
    const Drag = {
        moved: false,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,

        bind(panel) {
            const header = panel.querySelector('.scbs-header');
            if (!header) return;
            header.addEventListener('mousedown', (ev) => {
                if (ev.button !== 0) return;   // 只认左键，中键右键不参与
                Drag.begin(panel, ev);
            });
        },

        begin(panel, ev) {
            const rect = panel.getBoundingClientRect();
            Drag.moved = false;
            Drag.startX = ev.clientX;
            Drag.startY = ev.clientY;
            Drag.startLeft = rect.left;
            Drag.startTop = rect.top;

            // 拖动期间关掉过渡，否则面板会"追"着鼠标飘
            panel.style.transition = 'none';
            document.body.style.userSelect = 'none';

            const onMove = (e) => Drag.onMove(panel, e);
            const onUp = (e) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                Drag.end(panel);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        },

        onMove(panel, ev) {
            const dx = ev.clientX - Drag.startX;
            const dy = ev.clientY - Drag.startY;

            // 位移不足阈值就还没进入拖动状态，这次按下最终会被当成点击
            if (!Drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
            Drag.moved = true;

            const w = panel.offsetWidth;
            const h = panel.offsetHeight;
            const left = Math.max(0, Math.min(Drag.startLeft + dx, viewportWidth() - w));
            const top = Math.max(0, Math.min(Drag.startTop + dy, viewportHeight() - h));

            Drag.apply(panel, left, top);
        },

        /** 用 inline style 定位。inline 优先级高于 class，能盖掉 CSS 里的 right */
        apply(panel, left, top) {
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
            panel.style.right = 'auto';
        },

        end(panel) {
            if (!Drag.moved) {
                // 没移动 —— 这是一次点击，交给 click 处理器去折叠/展开
                panel.style.transition = '';
                document.body.style.userSelect = '';
                return;
            }

            const collapsed = panel.classList.contains('scbs-collapsed');
            const pref = readPosPref() || {};
            const rect = panel.getBoundingClientRect();

            if (collapsed) {
                // 折叠态吸附到最近的边缘。
                // 按标签中心相对视口中心判断，而不是按鼠标落点 ——
                // 用户的意图是"把它搁到哪边"，中心点比落点更贴合直觉
                const centerX = rect.left + rect.width / 2;
                const side = centerX < viewportWidth() / 2 ? 'left' : 'right';
                const top = clampTop(rect.top, panel.offsetHeight);

                pref.collapsed = { side, top };
                panel.style.transition = 'left .18s ease-out, top .18s ease-out';
                Drag.apply(panel, side === 'left' ? 0 : viewportWidth() - rect.width, top);
            } else {
                pref.expanded = { left: rect.left, top: rect.top };
            }

            writePosPref(pref);
            document.body.style.userSelect = '';

            // 过渡用完就撤，否则之后每次改尺寸都会带上动画
            setTimeout(() => { panel.style.transition = ''; }, 220);

            // moved 的复位移到下一轮事件循环。
            // click 是紧跟着 mouseup 同步派发的，所以这里不能立刻清 ——
            // 清了就挡不住"拖动完顺手折叠"的误触。
            // 但也不能一直留着：留到下回点折叠按钮时才清，那一次点击正好会被误吞。
            // 放到下一轮，正好落在 click 之后。
            setTimeout(() => { Drag.moved = false; }, 0);
        },

        /**
         * 按持久化的记录恢复位置。在面板挂载、且折叠 class 已应用之后调用，
         * 因为折叠态的宽度要到那时才是最终值
         */
        restore(panel) {
            const pref = readPosPref();
            if (!pref) return;

            if (panel.classList.contains('scbs-collapsed')) {
                if (!pref.collapsed) return;
                const top = clampTop(pref.collapsed.top, panel.offsetHeight);
                Drag.apply(panel, pref.collapsed.side === 'left' ? 0 : viewportWidth() - panel.offsetWidth, top);
            } else if (pref.expanded) {
                const left = Math.max(0, Math.min(pref.expanded.left, viewportWidth() - panel.offsetWidth));
                const top = clampTop(pref.expanded.top, panel.offsetHeight);
                Drag.apply(panel, left, top);
            }
        },
    };

    /** 取当前页面的 g_sessionID，写操作必须带 */
    function getSessionId() {
        try {
            if (typeof g_sessionID !== 'undefined' && g_sessionID) return g_sessionID;
        } catch (e) { /* 同上 */ }
        // 退化：从 cookie 里取。只读取不打印（它等同登录态凭证）
        const m = document.cookie.match(/(?:^|;\s*)sessionid=([^;]+)/);
        return m ? m[1] : null;
    }

    // ========================================================================
    // 四、费用模块
    // ========================================================================
    //
    // 纯函数实现 Steam 的计价规则，并优先复用页面自身的函数。
    // 为什么两者都要：
    //   - 用页面函数能保证与 Steam 当前规则完全一致（万一规则调整）；
    //   - 自实现版本是兜底，防止页面函数被改名/移除导致脚本整体失效。
    //
    const Fee = {
        /** 取钱包信息。动态获取而非缓存引用，避免页面状态切换后引用失效 */
        wallet() {
            try {
                if (typeof g_rgWalletInfo !== 'undefined' && g_rgWalletInfo) return g_rgWalletInfo;
            } catch (e) { /* 忽略 */ }
            return null;
        },

        /** 各费率，缺省值取 Steam 的默认值 */
        rates() {
            const w = Fee.wallet() || {};
            return {
                publisher: parseFloat(w.wallet_publisher_fee_percent_default != null
                    ? w.wallet_publisher_fee_percent_default : 0.10),
                steam: parseFloat(w.wallet_fee_percent != null ? w.wallet_fee_percent : 0.05),
            };
        },

        /** 钱包最低价（分）。低于此值的挂单不合法 */
        minimum() {
            const w = Fee.wallet() || {};
            const n = parseInt(w.wallet_market_minimum, 10);
            return isNaN(n) ? 1 : n;
        },

        /** 货币最小增量 */
        increment() {
            const w = Fee.wallet() || {};
            const n = parseInt(w.wallet_currency_increment, 10);
            return isNaN(n) ? 1 : n;
        },

        /**
         * 价格钳制。Steam 规则：<= 下限的一律返回下限。
         * 这是"低价商品手续费异常高"的根源，务必理解。
         */
        toValidMarketPrice(nPrice) {
            if (typeof ToValidMarketPrice === 'function') {
                try { return ToValidMarketPrice(nPrice, Fee.wallet()); } catch (e) { /* 落到自实现 */ }
            }
            const nFloor = Fee.minimum();
            const nIncr = Fee.increment();
            if (nPrice <= nFloor) return nFloor;
            if (nPrice <= nIncr) return nIncr;
            if (nIncr > 1) {
                return Math.round(nPrice / nIncr) * nIncr;
            }
            return nPrice;
        },

        /** 单项费用 */
        calculateFee(baseAmount, pct) {
            if (typeof CalculateFee === 'function') {
                try { return CalculateFee(baseAmount, pct, Fee.wallet()); } catch (e) { /* 落到自实现 */ }
            }
            if (!(pct > 0)) return 0;
            return Fee.toValidMarketPrice(Math.floor(baseAmount * pct));
        },

        /**
         * 卖家实收 → 买家支付。
         * 这是"给定实收，展示买家要付多少"的方向。
         */
        getTotalWithFees(sellerReceives) {
            const r = Fee.rates();
            if (typeof GetTotalWithFees === 'function') {
                try {
                    return GetTotalWithFees(sellerReceives, r.publisher, r.steam, Fee.wallet());
                } catch (e) { /* 落到自实现 */ }
            }
            return Fee.toValidMarketPrice(sellerReceives)
                + Fee.calculateFee(sellerReceives, r.publisher)
                + Fee.calculateFee(sellerReceives, r.steam);
        },

        /**
         * 买家支付 → 卖家实收（反推）。
         * 这是上架定价的核心：我们想让"买家支付价"等于市场最低价，
         * 但 sellitem 接收的是实收，必须做这个反推。
         *
         * 页面函数内部是"初始猜测 + 最多 3 次迭代修正"，这里照搬其策略，
         * 保证自实现版本与页面版本结果一致。
         */
        getItemPriceFromTotal(buyerPays) {
            const r = Fee.rates();
            if (typeof GetItemPriceFromTotal === 'function') {
                try {
                    return GetItemPriceFromTotal(buyerPays, Fee.wallet());
                } catch (e) { /* 落到自实现 */ }
            }
            const nIncr = Fee.increment();
            const nFloor = Fee.minimum();
            const nInitialGuess = Math.floor(buyerPays / (1.0 + r.publisher + r.steam));
            const nMaxBase = buyerPays - 2 * nFloor;
            let nBase = Fee.toValidMarketPrice(Math.min(nInitialGuess, nMaxBase));

            for (let i = 0; i < 3; i++) {
                const nCalculated = Fee.getTotalWithFees(nBase);
                if (nCalculated === buyerPays) return nBase;
                if (nCalculated < buyerPays) {
                    nBase += nIncr;
                } else {
                    nBase -= nIncr;
                    break;
                }
            }
            // 迭代未能精确命中时，返回最接近且不超过目标的值。
            // 宁可略微低于市场最低价（成交概率高），也不越过它（破坏市场价）。
            let candidate = nBase;
            while (candidate > nFloor && Fee.getTotalWithFees(candidate) > buyerPays) {
                candidate -= nIncr;
            }
            return Math.max(candidate, nFloor);
        },

        /** 货币小数位。0 位小数货币（日元/韩元等）不解析小数点 */
        currencyDecimals() {
            const w = Fee.wallet() || {};
            const code = parseInt(w.wallet_currency, 10);
            // Steam 货币 ID：见 g_rgWalletInfo.wallet_currency
            const ZERO_DECIMAL = [4 /*JPY*/, 5 /*NOK*/, 10 /*KRW*/, 18 /*VND*/,
                                  22 /*IDR*/, 26 /*CLP*/, 29 /*PYG*/, 33 /*COP*/];
            return ZERO_DECIMAL.indexOf(code) >= 0 ? 0 : 2;
        },

        /**
         * 把 "¥ 0.21" / "$1,234.56" 这类格式化价格解析成整数分。
         *
         * 坑位：不同地区的小数点与千分位符号不同（欧洲用 , 作小数点），
         * 所以不能简单 replace 掉所有非数字。这里的策略是：
         * 取最后一个分隔符作为小数点，它左边的全部视为千分位剥掉。
         * 对 0 位小数货币，所有分隔符都当千分位。
         */
        parsePriceToCents(text) {
            if (text == null) return null;
            const s = String(text).replace(/[^\d.,]/g, '');
            if (!s) return null;

            const decimals = Fee.currencyDecimals();

            if (decimals === 0) {
                const v = parseInt(s.replace(/[.,]/g, ''), 10);
                return isNaN(v) ? null : v;
            }

            const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
            if (lastSep < 0) {
                const v = parseInt(s, 10);
                return isNaN(v) ? null : v * Math.pow(10, decimals);
            }

            const intPart = s.slice(0, lastSep).replace(/[.,]/g, '') || '0';
            let fracPart = s.slice(lastSep + 1);
            if (fracPart.length < decimals) {
                fracPart += '0'.repeat(decimals - fracPart.length);
            } else if (fracPart.length > decimals) {
                fracPart = fracPart.slice(0, decimals);
            }

            const whole = parseInt(intPart, 10) || 0;
            const frac = parseInt(fracPart, 10) || 0;
            return whole * Math.pow(10, decimals) + frac;
        },

        /** 分 → 显示用货币字符串。用页面函数保证符号与小位数正确 */
        formatCents(cents) {
            try {
                if (typeof v_currencyformat === 'function' && typeof GetCurrencyCode === 'function') {
                    const w = Fee.wallet() || {};
                    return v_currencyformat(cents, GetCurrencyCode(parseInt(w.wallet_currency, 10)));
                }
            } catch (e) { /* 落到下面的兜底 */ }
            const decimals = Fee.currencyDecimals();
            return decimals === 0
                ? String(cents)
                : (cents / Math.pow(10, decimals)).toFixed(decimals);
        },
    };

    /**
     * 按当前上架规则，把「市场最低价」换算成「我打算挂出的买家支付价」。
     *
     * 为什么换算的是买家支付价而不是实收：用户填的附加值（+0.02 元 / +1%）
     * 针对的是市场上看得见的那个挂牌价，也就是买家支付价。
     * 实收要等这个值定下来之后再用 Fee.getItemPriceFromTotal 反推。
     *
     * @param {number} lowestCents 市场最低价（分）
     * @returns {number} 目标买家支付价（分）
     */
    function applyPriceRule(lowestCents) {
        if (typeof lowestCents !== 'number' || lowestCents <= 0) return lowestCents;

        if (state.priceRule === 'fixed') {
            const yuan = parseFloat(state.fixedOffsetYuan);
            if (!isFinite(yuan) || yuan <= 0) return lowestCents;
            return lowestCents + Math.round(yuan * 100);
        }

        if (state.priceRule === 'percent') {
            const pct = parseFloat(state.percentOffset);
            if (!isFinite(pct) || pct === 0) return lowestCents;
            // 填 1 表示 +1%，即 ×1.01
            return Math.round(lowestCents * (1 + pct / 100));
        }

        return lowestCents;
    }

    // ========================================================================
    // 五、库存 API
    // ========================================================================

    const InventoryAPI = {
        /**
         * 拉取全量社区物品（卡牌、表情、背景、宝石都在这一个上下文里）。
         *
         * 为什么一次拉 2000：Steam 该端点支持 count 参数，一次拉全比翻页稳得多，
         * 且响应约 650KB / 400+ 件物品，完全在可接受范围。
         *
         * @returns {Promise<{assets: Array, descriptions: Array, total: number}>}
         */
        async fetchAll(steamId) {
            const url = `/inventory/${steamId}/${CONFIG.APPID}/${CONFIG.CONTEXTID}` +
                        `?l=schinese&count=${CONFIG.INVENTORY_FETCH_COUNT}`;

            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) {
                throw new Error(`库存请求失败：HTTP ${resp.status}`);
            }

            const data = await resp.json();
            if (!data || data.success !== 1) {
                // 常见原因：登录态失效，或库存设为私密
                throw new Error('库存接口返回 success != 1，通常是登录态失效或库存非公开');
            }

            return {
                assets: data.assets || [],
                descriptions: data.descriptions || [],
                total: data.total_inventory_count || 0,
            };
        },

        /**
         * 读取物品的标签值。
         *
         * 为什么不用 type 字符串判断卡牌：
         * type 形如 "Left 4 Dead 2 集换式卡牌"，是随 l= 语言参数本地化的，
         * 换个语言或 Steam 改文案就匹配不上。而 tags 里的 internal_name 是
         * 与语言无关的机器标识，实测：
         *   item_class = item_class_2  → 集换式卡牌
         *   cardborder = cardborder_0  → 普通卡
         *   cardborder = cardborder_1  → 闪卡
         * 这是上架前唯一的可靠判据 —— 判错会卖错东西。
         */
        tagOf(description, category) {
            const tags = description.tags || [];
            for (let i = 0; i < tags.length; i++) {
                if (tags[i].category === category) return tags[i].internal_name;
            }
            return null;
        },

        /**
         * 把 assets 与 descriptions 关联成可操作的条目列表。
         *
         * 关联键是 classid + instanceid：assets 是实例级（每张卡一条），
         * descriptions 是类型级（同名卡共享一条）。实测 433 条 asset 全部能匹配上。
         *
         * @returns {Array<Object>} 条目数组
         */
        buildItems(assets, descriptions) {
            // 先建索引，避免在循环里做 O(n) 查找 —— 433 × 373 的嵌套会明显拖慢
            const descIndex = new Map();
            for (const d of descriptions) {
                descIndex.set(`${d.classid}_${d.instanceid}`, d);
            }

            const items = [];
            for (const asset of assets) {
                const desc = descIndex.get(`${asset.classid}_${asset.instanceid}`);
                if (!desc) continue; // 理论上不会发生，防御性跳过

                const itemClass = InventoryAPI.tagOf(desc, 'item_class');
                const border = InventoryAPI.tagOf(desc, 'cardborder');

                items.push({
                    assetid: String(asset.assetid),
                    amount: parseInt(asset.amount, 10) || 1,
                    appid: asset.appid,
                    contextid: String(asset.contextid),
                    marketHashName: desc.market_hash_name,
                    name: desc.name,
                    type: desc.type,
                    iconUrl: desc.icon_url,
                    /**
                     * 这张卡属于哪个游戏（Steam 的 market_fee_app）。
                     * 批量取价要按它分组 —— /market/search/render/ 支持按游戏过滤，
                     * 一次请求能带回该游戏下多张卡的价格
                     */
                    gameAppid: desc.market_fee_app != null
                        ? String(desc.market_fee_app)
                        : String(desc.market_hash_name).split('-')[0],
                    /** 是否可上架。不可上架的直接不展示，避免用户选中后必然失败 */
                    marketable: desc.marketable === 1,
                    /** 是否集换式卡牌 */
                    isCard: itemClass === 'item_class_2',
                    /** 是否闪卡 */
                    isFoil: border === 'cardborder_1',
                });
            }
            return items;
        },
    };

    // ========================================================================
    // 六、价格 API
    // ========================================================================

    /**
     * 把 asset 级的物品列表按 market_hash_name 合并成分组。
     *
     * 只纳入"可上架的卡牌" —— 表情、背景、宝石不参与批量上架，
     * 留在列表里只会干扰选择。
     */
    function buildGroups(items) {
        const map = new Map();
        for (const it of items) {
            if (!it.marketable || !it.isCard) continue;

            let g = map.get(it.marketHashName);
            if (!g) {
                g = {
                    marketHashName: it.marketHashName,
                    name: it.name,
                    type: it.type,
                    iconUrl: it.iconUrl,
                    isFoil: it.isFoil,
                    /** 批量取价时用来把卡按游戏归组 */
                    gameAppid: it.gameAppid,
                    /** 该分组下的全部 asset 实例。上架时逐个发请求 */
                    assetids: [],
                    count: 0,
                };
                map.set(it.marketHashName, g);
            }
            g.assetids.push(it.assetid);
        }

        const groups = [...map.values()];
        for (const g of groups) g.count = g.assetids.length;
        return groups;
    }

    /**
     * 价格缓存的持久化。
     *
     * 为什么要持久化：260 个卡名按限速要查约 6.5 分钟，而这个结果在几小时内基本有效。
     * 缓存下来能让"下次打开页面"直接可用，省掉一整轮等待。
     *
     * 为什么只存确定的结果：见 queryBatch 里的三态说明 —— 若把"请求失败/被限流"
     * 也一并存进来，一个瞬时的 429 会让那张卡在接下来两小时里都显示成"无挂单"，
     * 而用户完全看不出来。
     */
    const PriceCacheStore = {
        /** 读取持久缓存，返回 { name: { data, ts } }。任何异常都退化为空表 */
        read() {
            try {
                const raw = localStorage.getItem(CONFIG.PRICE_CACHE_KEY);
                if (!raw) return {};
                const obj = JSON.parse(raw);
                if (!obj || typeof obj !== 'object') return {};

                // 顺手丢弃过期条目，避免这份缓存无限膨胀
                const now = Date.now();
                const alive = {};
                for (const key in obj) {
                    const entry = obj[key];
                    if (entry && typeof entry.ts === 'number' &&
                        now - entry.ts < CONFIG.PRICE_CACHE_PERSIST_TTL) {
                        alive[key] = entry;
                    }
                }
                return alive;
            } catch (e) {
                // 隐私模式、配额满、数据被改坏 —— 都只是拿不到缓存，不该影响主流程
                return {};
            }
        },

        /** 写入持久缓存。写失败（配额满等）静默忽略 */
        write(map) {
            try {
                localStorage.setItem(CONFIG.PRICE_CACHE_KEY, JSON.stringify(map));
                return true;
            } catch (e) {
                UI.warn('价格缓存写入失败（可能是 localStorage 配额不足）：' + e.message);
                return false;
            }
        },
    };

    const PriceAPI = {
        /**
         * 查询单个 market_hash_name 的市场最低价。
         *
         * 返回值语义：
         *   lowestCents    买家支付的最低挂单价
         *   youReceiveCents 按该价挂出时卖家的实际到手（已扣手续费）
         *
         * 坑位：查询失败时 Steam 仍返回 {"success":true}，只是没有 lowest_price 字段。
         * 因此判断成功与否必须看 lowest_price 是否存在，绝不能看 success。
         * 实测对不存在的物品名就是这种响应。
         */
        async queryLowest(marketHashName) {
            const w = Fee.wallet() || {};
            const currency = w.wallet_currency != null ? w.wallet_currency : 23;
            const country = w.wallet_country != null ? w.wallet_country : 'CN';

            const url = '/market/priceoverview/?appid=' + CONFIG.APPID +
                        '&currency=' + encodeURIComponent(currency) +
                        '&country=' + encodeURIComponent(country) +
                        '&market_hash_name=' + encodeURIComponent(marketHashName);

            const resp = await fetch(url, { credentials: 'include' });

            // 429 必须单独识别。它是"被限流"，不是"该物品没有报价" ——
            // 两者混在一起，会让限流期间的卡被误标成"无挂单"，
            // 而且一旦这种错误结果进入缓存，它会在整个缓存有效期内持续误导用户
            if (resp.status === 429) {
                throw new Error('RATE_LIMITED');
            }
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            const data = await resp.json();

            if (!data || !data.lowest_price) {
                // 这是"确认无挂单"（接口正常返回，只是没有 lowest_price 字段），
                // 与上面的请求失败是两回事：这个是确定结果，可以缓存
                return null;
            }

            const lowestCents = Fee.parsePriceToCents(data.lowest_price);
            if (lowestCents == null) return null;

            // 反推：要让买家支付等于市场最低价，自己应设置的"卖家实收"
            const sellerReceives = Fee.getItemPriceFromTotal(lowestCents);

            return {
                lowestCents,
                sellerReceivesCents: sellerReceives,
                // 实际到手就是 sellerReceives（因为 sellitem 的 price 就是实收）
                medianCents: data.median_price ? Fee.parsePriceToCents(data.median_price) : null,
                volume: data.volume || null,
            };
        },

        /**
         * 把本轮查到的确定结果合并进持久缓存并落盘。
         * 必须先读再合并 —— 直接覆盖会把上一次会话查到的、其它卡的价格全冲掉。
         */
        flushPersist(persist) {
            const stored = PriceCacheStore.read();
            for (const [name, entry] of persist) {
                stored[name] = entry;
            }
            PriceCacheStore.write(stored);
        },

    };

    /**
     * 底价查询队列。
     *
     * 为什么要队列，而不是原来那种"点一次跑一批"：
     *   1. 单张要能立刻出结果 —— 队列里只有它时就是直通，没有额外排队延迟；
     *   2. 连勾多张时又要削峰 —— 同时发多个请求会撞 429（实测 4 个并发就被限流）；
     *   3. 全程可中断 —— 全量 260 张要约 6.5 分钟，查到够用往往就想停。
     *
     * 三种来源都进这同一个队列，从而保证任何时候同一个卡名只会有一个在途请求：
     *   - 勾选某张卡
     *   - 点「查询底价」（全量补空缺）
     *   - 停止之后再次启动
     */
    /**
     * 市场搜索接口 —— 按游戏批量取价。
     *
     * 为什么需要它：priceoverview 只能逐张查，240 个卡名就要 240 次请求，
     * 而且实测它独享一个限流池 —— 一旦被限流整个查价就停摆。
     *
     * 关键实测结论：/market/search/render/ 与 priceoverview 【互相独立】——
     * priceoverview 返回 429 的同一时刻，这个接口仍然返回 200。
     * 所以它可以作为批量取价的主通道，priceoverview 退居精确补漏。
     *
     * 参数要点（实测确认，非官方文档）：
     *   norender=1                                    让端点返回 JSON 而非 HTML
     *   category_753_item_class[]=tag_item_class_2     限定为集换式卡牌
     *   category_753_Game[]=tag_app_<AppID>            按游戏过滤
     *   start / count                                  【count 参数无效】，每页固定 10 条
     *
     * 返回字段：hash_name / sell_price（整数分）/ sell_price_text / app_name / ...
     */
    const SearchAPI = {
        PAGE_SIZE: 10,
        /** 单个游戏最多翻多少页就放弃。正常游戏十几张卡，2 页足够 */
        MAX_PAGES: 12,

        async fetchPage(gameAppid, page) {
            const url = '/market/search/render/?norender=1&appid=' + CONFIG.APPID +
                        '&start=' + (page * SearchAPI.PAGE_SIZE) +
                        '&count=' + SearchAPI.PAGE_SIZE +
                        '&category_753_item_class%5B%5D=tag_item_class_2' +
                        '&category_753_Game%5B%5D=tag_app_' + encodeURIComponent(gameAppid);

            const resp = await fetch(url, { credentials: 'include' });
            if (resp.status === 429) throw new Error('RATE_LIMITED');
            if (!resp.ok) throw new Error('HTTP ' + resp.status);

            const data = await resp.json();
            return (data && data.results) || [];
        },

        /**
         * 拉取某个游戏下所有卡牌的价格，只保留 wanted 里需要的卡名。
         *
         * 为什么可以提前收工：翻页途中一旦把 wanted 全部找齐就停，
         * 不必把后面的页翻完 —— 实测多数游戏 1~2 页就够。
         *
         * @param {string} gameAppid
         * @param {Set<string>} wanted market_hash_name 集合
         * @returns {Promise<Map<string, number>>} hash_name -> 最低价（分）
         */
        async fetchGame(gameAppid, wanted) {
            const got = new Map();

            for (let page = 0; page < SearchAPI.MAX_PAGES; page++) {
                const results = await SearchAPI.fetchPage(gameAppid, page);
                if (!results.length) break;

                for (const r of results) {
                    if (!r.hash_name || !wanted.has(r.hash_name)) continue;
                    if (got.has(r.hash_name)) continue;
                    // sell_price 缺失表示该卡当前无挂单，跳过即可
                    if (typeof r.sell_price === 'number' && r.sell_price > 0) {
                        got.set(r.hash_name, r.sell_price);
                    }
                }

                if (got.size >= wanted.size) break;
                if (page < SearchAPI.MAX_PAGES - 1) await sleep(CONFIG.PRICE_QUERY_INTERVAL);
            }

            return got;
        },
    };

    const PriceQueue = {
        /**
         * 待处理任务（FIFO）。元素是任务对象而非裸卡名，因为有两条取价通道：
         *   { type: 'item', name }               单张，走 priceoverview（快，勾选时用）
         *   { type: 'game', appid, hashes: Set } 一批同游戏的卡，走 search/render（省请求，全量用）
         */
        pending: [],
        /** 已在待查队列中的卡名，用于去重 */
        queued: new Set(),
        /** worker 是否在跑 */
        running: false,
        /** 用户是否请求过停止。worker 会在当前这条查完后退出 */
        stopRequested: false,

        /**
         * 单个卡名入队。
         * @param {string} name market_hash_name
         * @param {Object} [opts] { force: true } 时忽略缓存强制重查
         * @returns {boolean} 是否真的入队了
         */
        enqueue(name, opts) {
            if (!name) return false;
            if (this.queued.has(name)) return false;

            // 已有新鲜价格就跳过，避免为同一张卡反复发请求
            if (!(opts && opts.force)) {
                const cached = state.priceCache.get(name);
                if (cached && Date.now() - cached.ts < CONFIG.PRICE_CACHE_TTL) return false;
            }

            this.queued.add(name);
            this.pending.push({ type: 'item', name });
            return true;
        },

        /**
         * 批量入队并启动 worker。
         * @returns {number} 实际入队数量（已被价格覆盖的不计）
         */
        enqueueMany(names, opts) {
            let added = 0;
            for (const name of names) {
                if (this.enqueue(name, opts)) added++;
            }
            if (added > 0) this.start();
            return added;
        },

        /**
         * 把某个卡名移出待查队列。
         * 用户取消勾选时调用 —— 既然不打算卖它，就没必要为它花一次请求。
         * 已经查到的价格不会动，下次再勾选会直接显示。
         */
        remove(name) {
            if (!this.queued.has(name)) return;
            this.queued.delete(name);

            for (let i = 0; i < this.pending.length; i++) {
                const task = this.pending[i];
                if (task.type === 'item' && task.name === name) {
                    this.pending.splice(i, 1);
                    return;
                }
                // 游戏批次：只摘掉这一个卡名；整批都空了才把任务一起撤掉
                if (task.type === 'game' && task.hashes.has(name)) {
                    task.hashes.delete(name);
                    if (!task.hashes.size) this.pending.splice(i, 1);
                    return;
                }
            }
        },

        /** 清空待查队列（不影响已查到的结果） */
        clear() {
            this.pending.length = 0;
            this.queued.clear();
        },

        /** 请求停止：清空队列，worker 会在当前这条查完后退出 */
        requestStop() {
            this.stopRequested = true;
            this.clear();
        },

        /** 启动 worker。已在跑则什么都不做 */
        start() {
            if (this.running) return;
            this.stopRequested = false;
            this.running = true;
            this.run();
        },

        /**
         * 按游戏批量入队（全量查询走这条）。
         *
         * 为什么全量查询不逐张入队：240 个卡名逐张查要 240 次请求，
         * 而按游戏分组后每个游戏只需 1~2 页就连带拿回该游戏所有卡的价格。
         *
         * @param {Array} groups 分组列表（state.groups）
         * @returns {number} 实际纳入的卡名数
         */
        enqueueGames(groups) {
            const byGame = new Map();

            for (const g of groups) {
                const name = g.marketHashName;
                if (this.queued.has(name)) continue;

                // 已有新鲜价格就跳过，避免为同一张卡反复发请求
                const cached = state.priceCache.get(name);
                if (cached && Date.now() - cached.ts < CONFIG.PRICE_CACHE_TTL) continue;

                const appid = g.gameAppid || String(name).split('-')[0];
                if (!byGame.has(appid)) byGame.set(appid, new Set());
                byGame.get(appid).add(name);
                this.queued.add(name);
            }

            let n = 0;
            for (const [appid, hashes] of byGame) {
                this.pending.push({ type: 'game', appid, hashes });
                n += hashes.size;
            }
            if (n > 0) this.start();
            return n;
        },

        /** worker 主体：串行取队列，按任务类型分派 */
        async run() {
            const persist = new Map();

            while (this.pending.length && !this.stopRequested) {
                const task = this.pending.shift();

                if (task.type === 'game') {
                    for (const h of task.hashes) this.queued.delete(h);
                    await this.runGameTask(task, persist);
                } else {
                    this.queued.delete(task.name);
                    await this.runItemTask(task.name, persist);
                }

                Panel.reportQueue();

                // 分批落盘，避免每查一条就把整张缓存表序列化一遍
                if (persist.size >= CONFIG.PRICE_CACHE_FLUSH_EVERY) {
                    PriceAPI.flushPersist(persist);
                    persist.clear();
                }

                // 队列空了或用户要求停止时不再等待，立刻退出
                if (this.pending.length && !this.stopRequested) {
                    await sleep(CONFIG.PRICE_QUERY_INTERVAL);
                }
            }

            // 收尾落盘，把最后不足一批的条目也写进去
            if (persist.size) PriceAPI.flushPersist(persist);

            this.running = false;
            this.stopRequested = false;
            Panel.onQueueDrained();
        },

        /**
         * 单张查询：走 priceoverview。勾选某张卡时用这条 —— 一次请求约一秒出价。
         *
         * 三态语义，必须分清，否则缓存会固化错误：
         *   {…}        查到价格
         *   null       接口正常返回，确实没有挂单
         *   undefined  请求失败或被限流 —— 结果未知，绝不写入任何缓存
         */
        async runItemTask(name, persist) {
            let data;
            let certain = false;
            let failKind = null;
            try {
                data = await PriceAPI.queryLowest(name);
                certain = true;
            } catch (e) {
                data = undefined;
                failKind = (e.message === 'RATE_LIMITED') ? 'limit' : 'error';
                if (failKind === 'limit') {
                    UI.warn(`"${name}" 被限流（429），本轮未取到价格`);
                } else {
                    UI.warn(`"${name}" 查询失败：${e.message}`);
                }
            }

            if (certain) {
                const entry = { data, ts: Date.now() };
                state.priceCache.set(name, entry);
                persist.set(name, entry);
                // 这次拿到了结果，之前记录的失败状态作废
                state.priceErrors.delete(name);
            } else {
                state.priceErrors.set(name, failKind);
            }

            // 每查完一条立刻刷新那一行。刻意不重建整个列表 ——
            // 313 行 innerHTML 重建的开销在逐条刷新时会累积成肉眼可见的卡顿
            Panel.updatePriceCells(name);
        },

        /**
         * 批量查询：一个游戏一次，走 search/render。
         *
         * 拿到的卡算出售家实收写入缓存；没拿到的标记为 'missing' ——
         * 它表示"该游戏市场里没有这张卡的挂单"，是确定结论而非失败，
         * 因此可以像"无挂单"一样展示，但不能当成查询错误。
         */
        async runGameTask(task, persist) {
            let got;
            try {
                got = await SearchAPI.fetchGame(task.appid, task.hashes);
            } catch (e) {
                // 整批失败：绝不能给任何卡写"无挂单"，那会是错误结论。
                // 只标失败原因，留着后续补漏或下轮重试
                const kind = (e.message === 'RATE_LIMITED') ? 'limit' : 'error';
                for (const h of task.hashes) state.priceErrors.set(h, kind);
                UI.warn(`游戏 ${task.appid} 批量取价失败：${e.message}`);
                for (const h of task.hashes) Panel.updatePriceCells(h);
                return;
            }

            for (const h of task.hashes) {
                const lowest = got.get(h);
                if (typeof lowest === 'number' && lowest > 0) {
                    const entry = {
                        data: {
                            lowestCents: lowest,
                            sellerReceivesCents: Fee.getItemPriceFromTotal(lowest),
                        },
                        ts: Date.now(),
                    };
                    state.priceCache.set(h, entry);
                    persist.set(h, entry);
                    state.priceErrors.delete(h);
                } else {
                    state.priceErrors.set(h, 'missing');
                }
                Panel.updatePriceCells(h);
            }
        },
    };

    // ========================================================================
    // 七、上架 API
    // ========================================================================

    const SellAPI = {
        /**
         * 发起一笔上架请求。
         *
         * 参数要点（由 Steam 卖框源码实测确认）：
         *   price  = 卖家实收金额（分），不是买家支付价
         *   amount = 上架数量，卡牌恒为 1
         *
         * 响应要点：
         *   success: true + needs_mobile_confirmation: true
         *   → 请求已受理，但必须在 Steam 手机 App 里确认后才真正生效。
         *   这不是失败，脚本无法绕过（绕过需要用户的令牌 secret，不该由脚本持有）。
         */
        async sellItem(item, sellerReceivesCents) {
            const sessionId = getSessionId();
            if (!sessionId) {
                throw new Error('拿不到 sessionid，可能登录态已失效');
            }

            // 客户端侧的合法性校验，与服务端规则一致。
            // 提前拦住非法值，避免发起一笔注定异常或定价错误的请求
            const nFloor = Fee.minimum();
            if (!(sellerReceivesCents >= nFloor)) {
                throw new Error(`实收价 ${sellerReceivesCents} 低于钱包最低限额 ${nFloor}，拒绝发起`);
            }

            const body = new URLSearchParams({
                sessionid: sessionId,
                appid: String(item.appid),
                contextid: String(item.contextid),
                assetid: item.assetid,
                amount: String(item.amount),
                price: String(sellerReceivesCents),
            });

            const resp = await fetch('/market/sellitem/', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    // 这两个头缺一可能被 Steam 判定为非 AJAX 请求而拒绝
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: body.toString(),
            });

            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }

            let data;
            try {
                data = await resp.json();
            } catch (e) {
                throw new Error('响应不是 JSON，可能被重定向到登录页');
            }

            return {
                success: !!data.success,
                needsMobileConfirm: !!data.needs_mobile_confirmation,
                needsEmailConfirm: !!data.needs_email_confirmation,
                message: data.message || null,
            };
        },

        /**
         * 批量发起上架。
         *
         * 流程：逐笔发起 → 每笔之间限速 → 发满一批就停下等用户去手机确认。
         * 为什么不做成"一直发到完"：手机确认页一次要处理几十条，
         * 发太多会让待确认列表失控，用户体验反而更差。
         */
        async sellBatch(entries, onProgress) {
            const results = [];

            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                try {
                    const r = await SellAPI.sellItem(entry.item, entry.sellerReceivesCents);
                    results.push({
                        item: entry.item,
                        ok: r.success,
                        needsMobileConfirm: r.needsMobileConfirm,
                        message: r.message,
                    });
                } catch (e) {
                    results.push({
                        item: entry.item,
                        ok: false,
                        needsMobileConfirm: false,
                        message: e.message,
                    });
                }

                if (onProgress) onProgress(i + 1, entries.length, results[results.length - 1]);
                if (i < entries.length - 1) await sleep(CONFIG.SELL_INTERVAL);
            }

            return results;
        },
    };

    // ========================================================================
    // 八、UI 面板
    // ========================================================================

    const Panel = {
        root: null,

        /** 创建面板骨架。只做一次，后续都走 update 局部刷新 */
        mount() {
            if (document.getElementById(CONFIG.PANEL_ID)) return;

            const panel = document.createElement('div');
            panel.id = CONFIG.PANEL_ID;
            panel.innerHTML = Panel.template();
            document.body.appendChild(panel);
            Panel.root = panel;

            // 恢复上次的折叠状态。首次使用没有记录，默认展开，
            // 让用户先看见面板长什么样；之后收成小标签就会被记住
            if (readCollapsedPref()) {
                panel.classList.add('scbs-collapsed');
            }

            Panel.bindEvents();
            Panel.syncRuleInput();
            Panel.syncKeepInput();
            Drag.bind(panel);
            // 位置恢复必须放在折叠 class 应用之后 —— 折叠态的宽度到那时才是最终值
            Drag.restore(panel);

            // 窗口尺寸变化后原来的坐标可能已经越界，重新钳制一次
            window.addEventListener('resize', () => Panel.relayout());
        },

        template() {
            return `
                <div class="scbs-header" data-action="toggle">
                    <span class="scbs-title">卡牌批量上架</span>
                    <span class="scbs-toggle" data-action="toggle">
                        <span class="scbs-toggle-collapse">—</span>
                        <span class="scbs-toggle-expand">+</span>
                    </span>
                </div>
                <div class="scbs-body">
                    <div class="scbs-toolbar">
                        <button data-action="load" class="scbs-btn scbs-btn-primary">刷新库存</button>
                        <button data-action="prices" class="scbs-btn" id="scbs-price-btn">查询底价</button>
                    </div>

                    <div class="scbs-filters">
                        <label for="scbs-filter-select">卡牌边框：</label>
                        <select id="scbs-filter-select">
                            <option value="card" selected>普通</option>
                            <option value="foil">闪亮</option>
                            <option value="all">全部</option>
                        </select>
                        <label class="scbs-repeat-toggle" title="只卖多余的。没有多余可卖的卡会从列表隐藏">
                            仅重复 <input type="checkbox" id="scbs-repeat-only">
                        </label>
                        <span id="scbs-keep-wrap" class="scbs-keep-wrap" style="display:none">
                            保留 <input type="number" id="scbs-keep-count" class="scbs-keep-input"
                                      min="0" step="1" value="1"> 张
                        </span>
                    </div>

                    <div class="scbs-rule-row">
                        <label for="scbs-rule-select">上架规则：</label>
                        <select id="scbs-rule-select">
                            <option value="lowest" selected>底价上架</option>
                            <option value="fixed">固定附加</option>
                            <option value="percent">百分比附加</option>
                        </select>
                        <span id="scbs-rule-input-wrap" class="scbs-rule-input-wrap" style="display:none">
                            <input type="number" id="scbs-rule-input" class="scbs-rule-input"
                                   min="0" step="0.01" inputmode="decimal">
                            <span id="scbs-rule-unit" class="scbs-rule-unit"></span>
                        </span>
                    </div>

                    <div class="scbs-stats" id="scbs-stats">尚未加载</div>

                    <div class="scbs-actions">
                        <button data-action="select-all" class="scbs-btn scbs-btn-sm">全选</button>
                        <button data-action="select-none" class="scbs-btn scbs-btn-sm">清空</button>
                        <button data-action="select-invert" class="scbs-btn scbs-btn-sm">反选</button>
                        <button data-action="select-priced" class="scbs-btn scbs-btn-sm"
                                title="勾选所有已经查到最低价的卡">底价</button>
                    </div>

                    <div class="scbs-list" id="scbs-list"></div>

                    <div class="scbs-footer">
                        <button data-action="sell" class="scbs-btn scbs-btn-danger">批量上架选中项</button>
                        <div class="scbs-status" id="scbs-status"></div>
                    </div>
                </div>
            `;
        },

        bindEvents() {
            Panel.root.addEventListener('click', async (ev) => {
                const target = ev.target.closest('[data-action]');
                if (!target) return;
                const action = target.getAttribute('data-action');

                // 忙碌时屏蔽所有操作入口，防止连点造成并发请求风暴
                if (state.busy && action !== 'toggle') return;

                switch (action) {
                    case 'toggle': {
                        // 刚拖动过就不要顺手把面板折叠了 —— 那次按下是为了移动，不是切换形态
                        if (Drag.moved) { Drag.moved = false; return; }

                        const collapsed = Panel.root.classList.contains('scbs-collapsed');
                        // 展开态下只认右侧那个折叠按钮 —— 否则用户想点面板空白处时会误收；
                        // 收成小标签后整个标签任意位置都可点 —— 标签本来就只有一条，不必精准命中
                        if (!collapsed && !ev.target.closest('.scbs-toggle')) return;

                        const next = !collapsed;
                        Panel.root.classList.toggle('scbs-collapsed', next);
                        writeCollapsedPref(next);
                        // 形态变了宽度也变，位置必须跟着重算
                        Panel.relayout();
                        break;
                    }
                    case 'load':
                        await Panel.onLoad();
                        break;
                    case 'prices':
                        Panel.onTogglePriceScan();
                        break;
                    case 'select-all':
                        Panel.bulkSelect(true);
                        break;
                    case 'select-none':
                        state.selected.clear();
                        Panel.renderList();
                        break;
                    case 'select-invert':
                        Panel.bulkSelect(null);
                        break;
                    case 'select-priced': {
                        const n = Panel.selectPriced();
                        Panel.setStatus(n
                            ? `已勾选 ${n} 张有底价的卡`
                            : '当前筛选下没有已查到价格的卡');
                        break;
                    }
                    case 'sell':
                        await Panel.onSell();
                        break;
                }
            });

            // 勾选状态用事件委托，避免为几百个复选框各绑一个监听器
            Panel.root.addEventListener('change', (ev) => {
                const cb = ev.target.closest('input[data-hash]');
                if (!cb) return;
                const hash = cb.dataset.hash;
                const group = state.groups.find((g) => g.marketHashName === hash);
                if (!group) return;

                // 用 targetAssetids 而不是 assetids：开着「仅重复」时，
                // 一个 X5 的分组只该选中 4 个（保留 1 张）
                const targets = Panel.targetAssetids(group);

                if (cb.checked) {
                    // 整组一起选。Steam 的上架接口是单个 asset 的，
                    // 所以勾一个 X3 分组等于把 3 个 asset 全部标为待上架
                    for (const id of targets) state.selected.add(id);
                    // 勾选即入队查底价。队列里只有它时是直通处理，
                    // 所以体验是"勾上后约一秒出价"，而不是排在别人后面等
                    PriceQueue.enqueueMany([hash]);
                    // 必须立刻刷这一行：否则单元格停在"—"，用户完全看不出
                    // 查询已经开始，会以为这个功能不存在
                    Panel.updatePriceCells(hash);
                } else {
                    for (const id of targets) state.selected.delete(id);
                    // 不卖了就没必要为它花一次请求。
                    // 已经查到的价格保留 —— 万一又勾回来，不必重查
                    PriceQueue.remove(hash);
                }
                Panel.updateStats();
            });

            Panel.root.addEventListener('change', (ev) => {
                const sel = ev.target.closest('#scbs-filter-select');
                if (!sel) return;
                state.filter = sel.value;
                Panel.renderList();
            });

            // 上架规则切换：显示对应输入框，并让列表里的"到手"按新规则重算
            Panel.root.addEventListener('change', (ev) => {
                const sel = ev.target.closest('#scbs-rule-select');
                if (!sel) return;
                state.priceRule = sel.value;
                Panel.syncRuleInput();
                Panel.refreshAllPrices();
            });

            // 附加值输入。用 input 事件以便边打边看效果，
            // 但只重刷价格单元格而不是重建整个列表 —— 后者在每次击键时重建 300+ 行会明显卡顿
            Panel.root.addEventListener('input', (ev) => {
                const inp = ev.target.closest('#scbs-rule-input');
                if (!inp) return;
                if (state.priceRule === 'fixed') {
                    state.fixedOffsetYuan = inp.value;
                } else if (state.priceRule === 'percent') {
                    state.percentOffset = inp.value;
                }
                Panel.refreshAllPrices();
            });

            // 「仅重复」开关。
            // 切换时必须按新规则重算已选内容 —— 否则一个已经勾好的 X5 分组，
            // 会在开关打开后仍然选着 5 张，与"只卖 4 张"的预期不符
            Panel.root.addEventListener('change', (ev) => {
                const rep = ev.target.closest('#scbs-repeat-only');
                if (!rep) return;

                // 先记下哪些分组当前处于选中状态，再切规则
                const selectedHashes = new Set();
                for (const g of state.groups) {
                    if (g.assetids.some((id) => state.selected.has(id))) {
                        selectedHashes.add(g.marketHashName);
                    }
                }

                state.repeatOnly = rep.checked;
                Panel.syncKeepInput();
                state.selected.clear();

                // 按新规则重建选中集合
                for (const g of state.groups) {
                    if (!selectedHashes.has(g.marketHashName)) continue;
                    // 新规则下没有多余可卖的，自然落选
                    if (state.repeatOnly && g.count <= state.keepCount) continue;
                    for (const id of Panel.targetAssetids(g)) state.selected.add(id);
                }

                Panel.renderList();
            });

            // 保留数量变化：同样要按新规则重算选中与列表
            Panel.root.addEventListener('input', (ev) => {
                const inp = ev.target.closest('#scbs-keep-count');
                if (!inp) return;
                const n = parseInt(inp.value, 10);
                state.keepCount = (isNaN(n) || n < 0) ? 0 : n;
                Panel.refreshAfterKeepChange();
            });
        },

        /** 按当前筛选条件取出要展示的分组 */
        visibleGroups() {
            let groups = state.groups;
            if (state.filter === 'foil') groups = groups.filter((g) => g.isFoil);
            else if (state.filter === 'card') groups = groups.filter((g) => !g.isFoil);

            // 「仅重复」开启时把"没有多余可卖"的卡直接隐藏 —— 留在列表里
            // 既不能勾选也没信息量，只会干扰判断
            if (state.repeatOnly) groups = groups.filter((g) => g.count > state.keepCount);

            return groups;
        },

        /**
         * 该分组实际要卖哪几个 asset。
         *
         * 「仅重复」开启时保留 1 张、卖掉其余 —— 这正是它与"筛掉单张卡"的
         * 区别所在：它不是筛选条件，而是决定每组卖几张。
         * 例：一张 X5 的卡，开着开关勾选只会选中 4 个 asset。
         */
        targetAssetids(group) {
            if (state.repeatOnly) {
                return group.assetids.slice(0, Math.max(group.count - state.keepCount, 0));
            }
            return group.assetids;
        },

        /**
         * 该分组在列表里应该显示成几张。
         * 开着「仅重复」时是"要卖的张数"（总数减保留数），否则就是库存张数。
         * 例：6 张卡保留 4 张 → 显示 2
         */
        displayCount(group) {
            return state.repeatOnly
                ? Math.max(group.count - state.keepCount, 0)
                : group.count;
        },

        /** 该分组的目标 asset 是否都已选中（分组勾选是原子的，不存在选一半的状态） */
        isGroupSelected(group) {
            const targets = Panel.targetAssetids(group);
            if (!targets.length) return false;
            return targets.every((id) => state.selected.has(id));
        },

        setStatus(text, kind) {
            const el = document.getElementById('scbs-status');
            if (!el) return;
            el.textContent = text || '';
            el.className = 'scbs-status' + (kind ? ' scbs-' + kind : '');
        },

        updateStats() {
            const el = document.getElementById('scbs-stats');
            if (!el) return;
            const groups = Panel.visibleGroups();
            // 用 displayCount 而不是 count：开着仅重复时口径要与列表显示一致，
            // 否则会出现"展示 3 种 / 12 张"但列表里只看到 4 张的错位
            const totalCards = groups.reduce((sum, g) => sum + Panel.displayCount(g), 0);
            const sellable = groups.reduce((sum, g) => sum + Panel.targetAssetids(g).length, 0);
            // 三种口径都要给：种=多少类卡，张=库存共多少张，
            // 可卖=按当前规则实际会上架多少张（开着「仅重复」会比总数少）
            el.textContent = `展示 ${groups.length} 种 / ${totalCards} 张 · 可卖 ${sellable} 张` +
                             ` · 已选 ${state.selected.size} 张`;
        },

        /** 仅在勾选「仅重复」时显示保留数量输入框 */
        syncKeepInput() {
            const wrap = document.getElementById('scbs-keep-wrap');
            if (!wrap) return;
            wrap.style.display = state.repeatOnly ? 'flex' : 'none';
        },

        /**
         * 「保留数量」变化后重算选中集合与列表。
         *
         * 为什么要连选中一起重算：保留数从 1 改成 4 时，原本选中的 X3 分组
         * 已经变成"没有多余可卖"，那些 assetid 必须从已选里摘掉 ——
         * 否则会留下"选了但列表里看不见"的幽灵条目，上架时才暴露。
         */
        refreshAfterKeepChange() {
            const selectedHashes = new Set();
            for (const g of state.groups) {
                if (g.assetids.some((id) => state.selected.has(id))) {
                    selectedHashes.add(g.marketHashName);
                }
            }

            state.selected.clear();
            for (const g of state.groups) {
                if (!selectedHashes.has(g.marketHashName)) continue;
                if (state.repeatOnly && g.count <= state.keepCount) continue;
                for (const id of Panel.targetAssetids(g)) state.selected.add(id);
            }

            Panel.renderList();
        },

        /** 当前上架规则的可读描述，用于确认框与状态提示 */
        ruleLabel() {
            if (state.priceRule === 'fixed') {
                return `市场最低价 + ${state.fixedOffsetYuan || '0'} 元`;
            }
            if (state.priceRule === 'percent') {
                return `市场最低价 × (1 + ${state.percentOffset || '0'}%)`;
            }
            return '等于市场最低价';
        },

        /** 按当前规则显示/隐藏附加值输入框，并切换单位与占位文案 */
        syncRuleInput() {
            const wrap = document.getElementById('scbs-rule-input-wrap');
            const input = document.getElementById('scbs-rule-input');
            const unit = document.getElementById('scbs-rule-unit');
            if (!wrap || !input || !unit) return;

            if (state.priceRule === 'lowest') {
                wrap.style.display = 'none';
                return;
            }

            wrap.style.display = 'flex';
            if (state.priceRule === 'fixed') {
                unit.textContent = '元';
                input.placeholder = '0.02';
                input.step = '0.01';
                input.value = state.fixedOffsetYuan;
            } else {
                unit.textContent = '%';
                input.placeholder = '1';
                input.step = '0.1';
                input.value = state.percentOffset;
            }
        },

        /**
         * 只重刷价格单元格，不重建列表。
         *
         * 切换规则或修改附加值时要让"到手"立刻跟着变，但重建整张列表
         * （300+ 行 innerHTML）在连续击键时会明显卡顿，所以只改价格那一格。
         */
        refreshAllPrices() {
            const listEl = document.getElementById('scbs-list');
            if (!listEl) return;
            const cells = listEl.querySelectorAll('.scbs-price');
            for (const cell of cells) {
                const h = cell.dataset.hash;
                cell.innerHTML = Panel.priceCellHtml(h, PriceQueue.queued.has(h));
            }
        },

        /**
         * 形态切换或视口变化后重算位置。
         *
         * 两种形态宽度差一个数量级，沿用切换前的 left 很可能把面板推出视口；
         * 窗口缩小时同理 —— 原本贴右边的坐标会落到可视区之外。
         */
        relayout() {
            const panel = Panel.root;
            if (!panel) return;

            const pref = readPosPref() || {};
            const rect = panel.getBoundingClientRect();

            if (panel.classList.contains('scbs-collapsed')) {
                // 小标签：贴边。优先用记录里的边，没有就按当前横向位置判断
                const side = pref.collapsed
                    ? pref.collapsed.side
                    : (rect.left + rect.width / 2 < viewportWidth() / 2 ? 'left' : 'right');
                const top = clampTop(rect.top, panel.offsetHeight);
                Drag.apply(panel, side === 'left' ? 0 : viewportWidth() - panel.offsetWidth, top);
            } else {
                // 展开态：用记录的位置，没有记录就把当前横向位置钳制进可视区
                const left = pref.expanded ? pref.expanded.left : rect.left;
                Drag.apply(panel,
                    Math.max(0, Math.min(left, viewportWidth() - panel.offsetWidth)),
                    clampTop(rect.top, panel.offsetHeight));
            }
        },

        /**
         * 生成价格单元格的 HTML。
         * @param {string} marketHashName
         * @param {boolean} [pending] 该卡当前是否排在待查队列里
         */
        priceCellHtml(marketHashName, pending) {
            if (pending) {
                return '<span class="scbs-pending">查询中…</span>';
            }
            const price = state.priceCache.get(marketHashName);
            if (price && price.data) {
                // 展示的是"按当前上架规则算出的最终挂出价"和对应的到手，
                // 而不是市场最低价本身 —— 否则切了规则后看到的收益数还是旧口径
                const lowest = price.data.lowestCents;
                const target = applyPriceRule(lowest);
                const receives = Fee.getItemPriceFromTotal(target);
                const tip = target !== lowest
                    ? ` title="市场最低价 ${Fee.formatCents(lowest)}，按当前规则上浮到 ${Fee.formatCents(target)}"`
                    : '';
                return `<span class="scbs-lowest"${tip}>${escapeHtml(Fee.formatCents(target))}</span>` +
                       `<span class="scbs-receive">到手 ${escapeHtml(Fee.formatCents(receives))}</span>`;
            }
            if (price) {
                // 缓存里有这条记录但 data 是 null —— 接口明确答复过"没有挂单"
                return '<span class="scbs-noprice">无挂单</span>';
            }
            // 查过但失败：必须和"无挂单"、"还没查"区分开，
            // 否则用户分不清"这卡没人卖"和"请求被拒了"
            const err = state.priceErrors.get(marketHashName);
            if (err === 'limit') {
                return '<span class="scbs-error" title="请求被 Steam 限流，稍后可重试">限流</span>';
            }
            if (err === 'error') {
                return '<span class="scbs-error" title="请求失败">失败</span>';
            }
            // 'missing' 是确定结论（该游戏的市场里没有这张卡的挂单），
            // 与"无挂单"同义，不能当作错误展示
            if (err === 'missing') {
                return '<span class="scbs-noprice">无挂单</span>';
            }
            return '<span class="scbs-noprice">—</span>';
        },

        /**
         * 只刷新指定卡名的价格单元格，不重建整个列表。
         *
         * 为什么不用属性选择器（.scbs-price[data-hash="..."]）：
         * 卡名里含括号、空格、单引号等字符，拼进选择器必须转义，很容易出错；
         * 直接遍历比较 dataset 更稳，而 313 行的遍历开销远小于重建整表 innerHTML。
         */
        updatePriceCells(marketHashName) {
            const listEl = document.getElementById('scbs-list');
            if (!listEl) return;
            const cells = listEl.querySelectorAll('.scbs-price');
            // pending 状态由队列实时决定，而不是由调用方传 —— 这样同一个方法
            // 既能用于"刚入队"（显示查询中），也能用于"查完了"（显示结果）
            const pending = PriceQueue.queued.has(marketHashName);
            const html = Panel.priceCellHtml(marketHashName, pending);
            for (const cell of cells) {
                if (cell.dataset.hash === marketHashName) {
                    cell.innerHTML = html;
                }
            }
        },

        renderList() {
            const listEl = document.getElementById('scbs-list');
            if (!listEl) return;

            const groups = Panel.visibleGroups();
            if (!groups.length) {
                listEl.innerHTML = state.loaded
                    ? '<div class="scbs-empty">当前筛选下没有可上架的卡牌</div>'
                    : '<div class="scbs-empty">正在读取库存…</div>';
                Panel.updateStats();
                return;
            }

            // 一次性拼字符串再赋值，避免几百次 DOM 插入造成卡顿
            const html = groups.map((g) => {
                const checked = Panel.isGroupSelected(g) ? 'checked' : '';
                const icon = g.iconUrl
                    ? `https://community.cloudflare.steamstatic.com/economy/image/${g.iconUrl}/64fx64f`
                    : '';
                // 价格单元格带 data-hash，供 updatePriceCells 做单行刷新时定位
                const pending = PriceQueue.queued.has(g.marketHashName);
                // 徽标显示的是"要卖几张"：开着仅重复时是「总数 − 保留数」，
                // 否则就是库存张数。为 1 时不加徽标（X1 是噪音）
                const showCount = Panel.displayCount(g);
                const countBadge = showCount > 1
                    ? `<span class="scbs-count">X${showCount}</span>`
                    : '';

                return `
                    <div class="scbs-row${g.isFoil ? ' scbs-foil' : ''}">
                        <input type="checkbox" data-hash="${escapeHtml(g.marketHashName)}" ${checked}>
                        ${icon ? `<img class="scbs-icon" src="${escapeHtml(icon)}" loading="lazy" alt="">` : ''}
                        <div class="scbs-info">
                            <div class="scbs-name" title="${escapeHtml(g.marketHashName)}">${escapeHtml(g.name)}${countBadge}</div>
                            <div class="scbs-type">${g.isFoil ? '闪卡' : '普通卡'} · ${escapeHtml(g.type)}</div>
                        </div>
                        <div class="scbs-price" data-hash="${escapeHtml(g.marketHashName)}">${Panel.priceCellHtml(g.marketHashName, pending)}</div>
                    </div>
                `;
            }).join('');

            listEl.innerHTML = html;
            Panel.updateStats();
        },

        /**
         * 批量勾选。
         * @param {boolean|null} value true=全选 false=清空 null=反选
         */
        /**
         * 勾选所有"已经查到最低价"的卡。
         *
         * 为什么需要它：查完价后往往只想卖那些确实有人挂单的卡（有价才有得卖），
         * 逐个手点太慢。这里只做【追加】勾选、不取消已有的 ——
         * 免得在已经挑好的选择上误操作；想反向筛选可以先点「清空」再点这个。
         *
         * @returns {number} 本次新勾选的张数（按 asset 计，重复卡按实际张数算）
         */
        selectPriced() {
            let added = 0;
            for (const g of Panel.visibleGroups()) {
                const p = state.priceCache.get(g.marketHashName);
                if (!p || !p.data) continue;             // 没有底价，跳过
                if (Panel.isGroupSelected(g)) continue;  // 已经选过了，不重复计

                const targets = Panel.targetAssetids(g);
                for (const id of targets) state.selected.add(id);
                added += targets.length;
            }
            Panel.renderList();
            return added;
        },

        bulkSelect(value) {
            for (const g of Panel.visibleGroups()) {
                // 反选以"整组"为单位判断：否则 X3 的分组会被拆成"选 1 张留 2 张"的
                // 中间态，而这个界面刻意不支持部分选中
                const fullySelected = Panel.isGroupSelected(g);
                for (const id of Panel.targetAssetids(g)) {
                    if (value === null) {
                        if (fullySelected) state.selected.delete(id);
                        else state.selected.add(id);
                    } else if (value) {
                        state.selected.add(id);
                    } else {
                        state.selected.delete(id);
                    }
                }
            }
            Panel.renderList();
        },

        /** 加载库存 */
        async onLoad() {
            const steamId = getSteamId();
            if (!steamId) {
                Panel.setStatus('拿不到 steamid，请确认当前在库存页', 'error');
                return;
            }

            state.busy = true;
            Panel.setStatus('正在拉取库存…');
            try {
                const { assets, descriptions, total } = await InventoryAPI.fetchAll(steamId);
                state.items = InventoryAPI.buildItems(assets, descriptions);
                state.groups = buildGroups(state.items);
                state.loaded = true;

                // 库存可能已变化（比如刚才上架成功的卡已不在库里），
                // 把已失效的勾选项清掉，否则统计数字虚高、上架时又找不到对应条目
                const validIds = new Set(state.items.map((it) => it.assetid));
                for (const assetid of [...state.selected]) {
                    if (!validIds.has(assetid)) state.selected.delete(assetid);
                }

                const cards = state.items.filter((it) => it.marketable && it.isCard);
                const foils = cards.filter((it) => it.isFoil);
                UI.log(`库存 ${total} 件，可上架卡牌 ${cards.length} 张（闪卡 ${foils.length} 张）`);

                Panel.renderList();
                Panel.setStatus(`已加载：可上架卡牌 ${cards.length} 张，其中闪卡 ${foils.length} 张`, 'ok');
            } catch (e) {
                UI.error('加载库存失败', e);
                Panel.setStatus('加载失败：' + e.message, 'error');
            } finally {
                state.busy = false;
            }
        },

        /**
         * 「查询底价 / 停止查询」二合一按钮的处理。
         *
         * 为什么合成一个按钮：这两个动作是同一个状态的两面 —— 要么待机、要么在扫。
         * 拆成两个按钮会出现"扫描进行中还能再点一次扫描"这种无意义的状态。
         */
        onTogglePriceScan() {
            if (PriceQueue.running) {
                PriceQueue.requestStop();
                // 这里不直接报"已停止"：worker 可能还在查当前那一条，
                // 等它退出后由 onQueueDrained 给出准确的收尾状态
                Panel.setStatus('正在停止…');
                return;
            }

            if (!state.loaded) {
                Panel.setStatus('请先加载库存', 'error');
                return;
            }

            if (!state.groups.length) {
                Panel.setStatus('没有可查询的卡牌', 'error');
                return;
            }

            // 全量查询走"按游戏批量"通道：一个游戏 1~2 页就能连带取回该游戏
            // 所有卡的价格，比逐张查省得多；而且这条通道不受 priceoverview 限流影响
            const added = PriceQueue.enqueueGames(state.groups);
            if (!added) {
                Panel.setStatus(`没有需要补查的卡（${state.groups.length} 个卡名都已有底价）`, 'ok');
                Panel.updatePriceButton();
                return;
            }

            Panel.updatePriceButton();
            Panel.setStatus(`已按游戏分批入队，共 ${added} 个卡名，开始查询…`);
        },

        /** 队列每推进一步时的状态反馈 */
        reportQueue() {
            if (!PriceQueue.running) return;
            // pending 里装的是任务而不是卡名，要展开才知道还剩多少张
            const remaining = PriceQueue.pending.reduce(
                (sum, t) => sum + (t.type === 'game' ? t.hashes.size : 1), 0);
            Panel.setStatus(`查询中… 剩余 ${remaining} 张`);
            Panel.updatePriceButton();
        },

        /** 队列结束（自然跑完或用户停止）后的收尾 */
        onQueueDrained() {
            let priced = 0, limited = 0, failed = 0;
            // 按"张"统计而不是"种"：用户关心的是要发多少笔，一张重复卡算 3 次
            for (const g of Panel.visibleGroups()) {
                const p = state.priceCache.get(g.marketHashName);
                if (p && p.data) { priced += g.count; continue; }
                const err = state.priceErrors.get(g.marketHashName);
                if (err === 'limit') limited += g.count;
                else if (err === 'error') failed += g.count;
            }

            // 把"被限流"单独报出来，否则用户会把它当成"这些卡都没人卖"
            let msg = `查询结束，当前 ${priced} 张有底价`;
            if (limited) msg += `，${limited} 项被限流未取到（稍后可重试）`;
            if (failed) msg += `，${failed} 项失败`;
            Panel.setStatus(msg, (limited || failed) ? 'error' : 'ok');
            Panel.updatePriceButton();
        },

        /** 按钮文案随队列状态切换 */
        updatePriceButton() {
            const btn = document.getElementById('scbs-price-btn');
            if (!btn) return;
            btn.textContent = PriceQueue.running ? '停止查询' : '查询底价';
            btn.classList.toggle('scbs-btn-active', PriceQueue.running);
        },

        /** 批量上架 */
        async onSell() {
            if (!state.loaded) {
                Panel.setStatus('请先加载库存', 'error');
                return;
            }
            if (!state.selected.size) {
                Panel.setStatus('还没有勾选任何卡牌', 'error');
                return;
            }

            // 组装待上架条目，并做定价前置检查
            const entries = [];
            const skipped = [];
            for (const item of state.items) {
                if (!state.selected.has(item.assetid)) continue;

                const cached = state.priceCache.get(item.marketHashName);
                if (!cached || !cached.data) {
                    skipped.push({ item, reason: '未查询到价格' });
                    continue;
                }
                // 按当前上架规则重算实收：缓存里存的是"按最低价挂出"的实收，
                // 而用户可能已经切到附加规则了
                const targetBuyer = applyPriceRule(cached.data.lowestCents);
                entries.push({
                    item,
                    sellerReceivesCents: Fee.getItemPriceFromTotal(targetBuyer),
                });
            }

            if (!entries.length) {
                Panel.setStatus('选中的卡牌都没有可用价格，请先查询价格', 'error');
                return;
            }

            const limit = CONFIG.SELL_BATCH_SIZE > 0
                ? Math.min(CONFIG.SELL_BATCH_SIZE, entries.length)
                : entries.length;
            const toSell = entries.slice(0, limit);

            const confirmMsg =
                `将发起 ${toSell.length} 笔上架请求` +
                (entries.length > limit ? `（本次受每批上限 ${limit} 限制，其余下次再发）` : '') +
                `\n\n定价规则：${Panel.ruleLabel()}\n` +
                `注意：真正生效需要在 Steam 手机 App 里批量确认。\n\n确认继续？`;
            if (!window.confirm(confirmMsg)) return;

            state.busy = true;
            try {
                const results = await SellAPI.sellBatch(toSell, (done, totalCount, last) => {
                    Panel.setStatus(`上架 ${done}/${totalCount}：${last.item.name} ` +
                        (last.ok ? (last.needsMobileConfirm ? '(待手机确认)' : '(已生效)') : `(失败：${last.message})`));
                });

                const okCount = results.filter((r) => r.ok).length;
                const needConfirm = results.filter((r) => r.ok && r.needsMobileConfirm).length;
                const failCount = results.filter((r) => !r.ok).length;

                let summary = `已发起 ${okCount}/${results.length} 笔`;
                if (needConfirm) summary += `，其中 ${needConfirm} 笔需手机确认`;
                if (failCount) summary += `，失败 ${failCount} 笔`;
                if (skipped.length) summary += `，跳过 ${skipped.length} 笔`;

                if (needConfirm) {
                    summary += ' —— 请打开 Steam 手机 App 批量确认';
                }
                Panel.setStatus(summary, failCount ? 'error' : 'ok');

                // 成功的项从勾选集里移除，避免用户再次点"上架"时重复发起
                for (const r of results) {
                    if (r.ok) state.selected.delete(r.item.assetid);
                }
                Panel.renderList();

                if (failCount) {
                    UI.warn('失败明细', results.filter((r) => !r.ok));
                }
            } catch (e) {
                UI.error('上架过程出错', e);
                Panel.setStatus('上架出错：' + e.message, 'error');
            } finally {
                state.busy = false;
            }
        },
    };

    // ========================================================================
    // 九、样式
    // ========================================================================

    function injectStyle() {
        if (document.getElementById(CONFIG.STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = CONFIG.STYLE_ID;
        style.textContent = `
            #${CONFIG.PANEL_ID} {
                position: fixed; top: 80px; right: 16px; width: 420px; max-height: 80vh;
                background: #1b2838; color: #c7d5e0; border: 1px solid #2a475e;
                border-radius: 4px; font-size: 12px; z-index: 99999;
                display: flex; flex-direction: column;
                box-shadow: 0 4px 16px rgba(0,0,0,.5);
            }
            #${CONFIG.PANEL_ID} .scbs-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 8px 10px; background: #2a475e; cursor: default;
            }
            #${CONFIG.PANEL_ID} .scbs-title { font-weight: bold; color: #fff; }
            #${CONFIG.PANEL_ID} .scbs-toggle { cursor: pointer; padding: 0 6px; user-select: none; }
            /* 折叠态：收成贴在右边缘的竖排小标签，把页面占位压到最小。
               定位从 right:16px 改到 right:0 —— 两者都作用于 right，
               靠这里多出的 .scbs-collapsed 类名取得更高的选择器优先级来覆盖 */
            #${CONFIG.PANEL_ID}.scbs-collapsed {
                width: auto; max-height: none;
                right: 0;
                border-radius: 4px 0 0 4px;
                opacity: .92;
            }
            #${CONFIG.PANEL_ID}.scbs-collapsed:hover { opacity: 1; }
            #${CONFIG.PANEL_ID}.scbs-collapsed .scbs-body { display: none; }
            #${CONFIG.PANEL_ID}.scbs-collapsed .scbs-header {
                flex-direction: column; padding: 10px 6px; cursor: pointer;
            }
            #${CONFIG.PANEL_ID}.scbs-collapsed .scbs-title {
                writing-mode: vertical-rl;   /* 竖排，贴边时几乎不占横向空间 */
                letter-spacing: 3px;
            }
            #${CONFIG.PANEL_ID}.scbs-collapsed .scbs-toggle { margin-top: 6px; }
            /* 展开态显示"—"，折叠态显示"+" */
            #${CONFIG.PANEL_ID} .scbs-toggle-expand { display: none; }
            #${CONFIG.PANEL_ID}.scbs-collapsed .scbs-toggle-collapse { display: none; }
            #${CONFIG.PANEL_ID}.scbs-collapsed .scbs-toggle-expand { display: inline; }
            #${CONFIG.PANEL_ID} .scbs-body { padding: 8px 10px; display: flex; flex-direction: column; overflow: hidden; }
            #${CONFIG.PANEL_ID} .scbs-toolbar,
            #${CONFIG.PANEL_ID} .scbs-actions { display: flex; gap: 6px; margin-bottom: 6px; }
            /* 标签、下拉、仅重复三者排在同一行。
               下拉给固定窄宽度，把横向空间让出来，避免"仅重复"被挤到下一行 */
            #${CONFIG.PANEL_ID} .scbs-filters {
                display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
            }
            #${CONFIG.PANEL_ID} .scbs-filters > label {
                color: #8f98a0; white-space: nowrap; flex-shrink: 0;
            }
            #${CONFIG.PANEL_ID} #scbs-filter-select {
                flex: 0 0 auto; width: 76px; box-sizing: border-box;
                background: #2a475e; color: #c7d5e0;
                border: 1px solid #3d6c8d; border-radius: 2px;
                padding: 4px 6px; font-size: 12px; cursor: pointer;
            }
            #${CONFIG.PANEL_ID} #scbs-filter-select:hover { background: #3d6c8d; color: #fff; }
            #${CONFIG.PANEL_ID} .scbs-repeat-toggle {
                display: flex; align-items: center; gap: 4px;
                cursor: pointer; color: #8f98a0; white-space: nowrap;
                flex-shrink: 0; margin-left: 12px;
            }
            #${CONFIG.PANEL_ID} .scbs-repeat-toggle:hover { color: #c7d5e0; }
            /* 「保留 N 张」输入组，只在勾选仅重复时出现，紧跟在其右侧 */
            #${CONFIG.PANEL_ID} .scbs-keep-wrap {
                display: flex; align-items: center; gap: 3px;
                color: #8f98a0; white-space: nowrap; flex-shrink: 0;
            }
            #${CONFIG.PANEL_ID} .scbs-keep-input {
                width: 46px; box-sizing: border-box; text-align: center;
                background: #16202d; color: #fff;
                border: 1px solid #3d6c8d; border-radius: 2px;
                padding: 4px; font-size: 12px;
            }
            #${CONFIG.PANEL_ID} .scbs-keep-input:focus { outline: none; border-color: #1a9fff; }
            /* 上架规则行：结构同筛选行，右侧按规则不同挂出输入框 */
            #${CONFIG.PANEL_ID} .scbs-rule-row {
                display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
            }
            #${CONFIG.PANEL_ID} .scbs-rule-row > label {
                color: #8f98a0; white-space: nowrap; flex-shrink: 0;
            }
            #${CONFIG.PANEL_ID} #scbs-rule-select {
                flex: 0 0 auto; width: 96px; box-sizing: border-box;
                background: #2a475e; color: #c7d5e0;
                border: 1px solid #3d6c8d; border-radius: 2px;
                padding: 4px 6px; font-size: 12px; cursor: pointer;
            }
            #${CONFIG.PANEL_ID} #scbs-rule-select:hover { background: #3d6c8d; color: #fff; }
            #${CONFIG.PANEL_ID} .scbs-rule-input-wrap {
                display: flex; align-items: center; gap: 3px; min-width: 0;
            }
            #${CONFIG.PANEL_ID} .scbs-rule-input {
                width: 72px; box-sizing: border-box;
                background: #16202d; color: #fff;
                border: 1px solid #3d6c8d; border-radius: 2px;
                padding: 4px 6px; font-size: 12px;
            }
            #${CONFIG.PANEL_ID} .scbs-rule-input:focus { outline: none; border-color: #1a9fff; }
            #${CONFIG.PANEL_ID} .scbs-rule-unit { color: #8f98a0; font-size: 11px; white-space: nowrap; }
            #${CONFIG.PANEL_ID} .scbs-rule-hint { color: #6b7680; font-size: 11px; white-space: nowrap; }
            #${CONFIG.PANEL_ID} .scbs-btn {
                background: #2a475e; color: #c7d5e0; border: none; border-radius: 2px;
                padding: 5px 10px; cursor: pointer; font-size: 12px;
            }
            #${CONFIG.PANEL_ID} .scbs-btn:hover { background: #3d6c8d; color: #fff; }
            /* 查询进行中的按钮态。用橙色区别于红色的"批量上架"，避免误认成危险操作 */
            #${CONFIG.PANEL_ID} .scbs-btn-active { background: #c47a2b; color: #fff; }
            #${CONFIG.PANEL_ID} .scbs-btn-primary { background: #1a9fff; color: #fff; }
            #${CONFIG.PANEL_ID} .scbs-btn-danger { background: #a74c3c; color: #fff; flex: 1; }
            #${CONFIG.PANEL_ID} .scbs-btn-sm { padding: 3px 8px; }
            #${CONFIG.PANEL_ID} .scbs-stats { margin-bottom: 6px; color: #8f98a0; }
            #${CONFIG.PANEL_ID} .scbs-list {
                flex: 1; overflow-y: auto; min-height: 120px; max-height: 46vh;
                border: 1px solid #2a475e; background: #16202d;
            }
            #${CONFIG.PANEL_ID} .scbs-row {
                display: flex; align-items: center; gap: 8px; padding: 5px 6px;
                border-bottom: 1px solid #22384d;
            }
            #${CONFIG.PANEL_ID} .scbs-row:hover { background: #1e2c3d; }
            #${CONFIG.PANEL_ID} .scbs-foil { background: rgba(255,215,0,.06); }
            #${CONFIG.PANEL_ID} .scbs-icon { width: 32px; height: 32px; flex-shrink: 0; }
            #${CONFIG.PANEL_ID} .scbs-info { flex: 1; min-width: 0; }
            #${CONFIG.PANEL_ID} .scbs-name {
                color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            #${CONFIG.PANEL_ID} .scbs-type {
                color: #8f98a0; font-size: 11px; white-space: nowrap;
                overflow: hidden; text-overflow: ellipsis;
            }
            #${CONFIG.PANEL_ID} .scbs-price { text-align: right; flex-shrink: 0; }
            #${CONFIG.PANEL_ID} .scbs-lowest { display: block; color: #beee11; }
            #${CONFIG.PANEL_ID} .scbs-receive { display: block; color: #8f98a0; font-size: 11px; }
            #${CONFIG.PANEL_ID} .scbs-noprice { color: #6b7680; }
            #${CONFIG.PANEL_ID} .scbs-pending { color: #f0a94c; font-size: 11px; }
            /* 重复数量徽标（X2 / X3） */
            #${CONFIG.PANEL_ID} .scbs-count {
                display: inline-block; margin-left: 5px; padding: 0 5px;
                background: #3d6c8d; color: #fff; border-radius: 8px;
                font-size: 10px; line-height: 15px; vertical-align: middle;
            }
            #${CONFIG.PANEL_ID} .scbs-error { color: #ff7b6b; font-size: 11px; }
            #${CONFIG.PANEL_ID} .scbs-empty { padding: 20px; text-align: center; color: #8f98a0; }
            #${CONFIG.PANEL_ID} .scbs-footer { margin-top: 8px; display: flex; align-items: center; gap: 8px; }
            #${CONFIG.PANEL_ID} .scbs-status { flex: 1; color: #8f98a0; word-break: break-all; }
            #${CONFIG.PANEL_ID} .scbs-status.scbs-ok { color: #beee11; }
            #${CONFIG.PANEL_ID} .scbs-status.scbs-error { color: #ff7b6b; }
        `;
        document.head.appendChild(style);
    }

    // ========================================================================
    // 十、启动
    // ========================================================================

    function initialize() {
        // 库存页和市场页都挂载。
        //
        // 市场页原本没在支持范围内，但实测它同样具备 g_steamID / g_sessionID /
        // g_rgWalletInfo，而库存数据是走接口拉的、不依赖页面上下文，
        // 所以没有理由不让人在这儿用 —— 浏览市场时想顺手清一下库存是常见场景。
        //
        // 这道判断仍然保留：Steam 有 SPA 式跳转的可能，@match 未必拦得住所有路径
        const p = location.pathname;
        const isSupportedPage = /\/inventory/.test(p) || /^\/market(\/|$)/.test(p);
        if (!isSupportedPage) return;

        // 把上次会话查到的价格预热进内存缓存，这样列表一渲染就能看到上次的结果。
        // 注意：预热进来的条目在"查询价格"时仍会按内存 TTL 判断是否重新查询，
        // 所以点一次查询就会把过期的旧价刷新掉，不会一直用旧数据
        const stored = PriceCacheStore.read();
        let warmed = 0;
        for (const name in stored) {
            state.priceCache.set(name, stored[name]);
            warmed++;
        }

        injectStyle();
        Panel.mount();
        UI.log('已就绪。' + (warmed ? `已从本地缓存预热 ${warmed} 个卡价。` : ''));

        // 挂载后自动刷一次库存 —— 打开页面就能看到卡牌列表，不必再手动点一下。
        // 这里不 await：初始化不该被网络请求阻塞，失败也只在状态栏提示
        Panel.onLoad();
    }

    // document-idle 时 DOM 已就绪，直接初始化即可
    initialize();
})();
