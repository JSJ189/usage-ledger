/**
 * 最小宿主替身（只保留 usage-ledger 真正用到的那部分 API）。
 *
 * 独立仓库不能依赖 pi-web-ui 的 `plugin-sdk/index.mjs`，这里按 `plugin-sdk/index.d.ts`
 * 的字段语义逐条对齐，只实现插件与单测用到的面：
 *  - `calls`：每次宿主方法调用记 `{ method, args, seq }`（命名空间方法记 `"ui.update"` 这种点分名）；
 *  - `logs`：`log(level?, ...args)` 的分级条目 `{ level, text }`（首参是 debug|info|warn|error
 *    才当级别，否则按 info；text 拼后截断 500 字符；error 同时打 console.error）；
 *  - 订阅/注册类返回注销函数；handler 存进 `mock.handlers`；路由/定时任务定义体存进
 *    `mock.routes` / `mock.schedules`（活数组，注销即摘除）；
 *  - `storage` 是内存实现（get/set/delete/has/keys/clear/all）；
 *  - `getSettings()` 返回 `overrides.settings` 同一引用（直接改即模拟变化）；
 *  - `overrides` 里传函数即整体替换该方法（命名空间传对象 = 按子键合并）；
 *  - `reset()` 只清 `calls` / `logs`。
 *
 * 与真宿主的两处刻意差异（单测友好）：`schedule()` 只记调用不设真定时器（用
 * `mock.fireSchedules()` 手动触发）；`fetch` 默认抛错（不联网）。
 */

const LEVELS = ["debug", "info", "warn", "error"];
const NAMESPACES = ["ui", "storage", "net", "events", "fs", "llm"];

function isPlainObject(v) {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

export function createMockHost(overrides = {}) {
	if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
		throw new Error("[mock-host] createMockHost 需要一个对象（或不传）");
	}
	const noop = () => {};
	const calls = [];
	const logs = [];
	const settingsState = { ...(isPlainObject(overrides.settings) ? overrides.settings : {}) };
	const handlerMap = new Map();
	const storeMap = new Map();
	const routeStore = [];
	const scheduleStore = [];
	const effectStore = [];
	const bgTaskStore = [];
	const uiItems = new Map();
	/** 所有 ui.update 调用（真宿主的条目来自 manifest 声明，mock 没注册也能断言）。 */
	const uiUpdates = [];

	const handlersOf = (method) => {
		let arr = handlerMap.get(method);
		if (!arr) {
			arr = [];
			handlerMap.set(method, arr);
		}
		return arr;
	};
	/** 订阅类：存 handler（argIndex 指定回调位置）+ 返回只摘本次的注销函数。 */
	const sub =
		(method, argIndex = 0) =>
		(...args) => {
			const handler = args[argIndex];
			if (typeof handler === "function") handlersOf(method).push(handler);
			let done = false;
			return () => {
				if (done) return;
				done = true;
				const arr = handlersOf(method);
				const i = arr.indexOf(handler);
				if (i >= 0) arr.splice(i, 1);
			};
		};
	/** 注册类：存定义体 + 返回只摘本次的注销函数。 */
	const remember = (store, entry) => {
		if (entry !== undefined) store.push(entry);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const i = store.indexOf(entry);
			if (i >= 0) store.splice(i, 1);
		};
	};
	const logImpl = (levelOrArg, ...args) => {
		const level = LEVELS.includes(levelOrArg) ? levelOrArg : "info";
		const parts = LEVELS.includes(levelOrArg) ? args : [levelOrArg, ...args];
		const text = parts
			.map((x) => {
				if (typeof x === "string") return x;
				try {
					return JSON.stringify(x) ?? String(x);
				} catch {
					return String(x);
				}
			})
			.join(" ")
			.slice(0, 500);
		logs.push({ level, text });
		if (level === "error") {
			try {
				console.error("[mock-host]", text);
			} catch {
				/* 打印失败不影响单测 */
			}
		}
	};

	const host = {
		// ── 会话 / 消息（插件只用 sendTo / onAttach / getActiveConversation）
		broadcast: noop,
		notify: noop,
		sendTo: noop,
		onMessage: sub("onMessage"),
		onAttach: sub("onAttach"),
		getActiveConversation: () => null,
		onToolEvent: sub("onToolEvent"),
		onRunEvent: sub("onRunEvent"),
		onStats: sub("onStats"),
		onStreaming: sub("onStreaming"),
		onSettingsChanged: sub("onSettingsChanged"),
		// ── 数据 / 存储
		storage: {
			get: (key, fallback) => (storeMap.has(key) ? storeMap.get(key) : fallback),
			set: (key, value) => {
				storeMap.set(key, value);
			},
			delete: (key) => {
				storeMap.delete(key);
			},
			has: (key) => storeMap.has(key),
			keys: () => [...storeMap.keys()],
			clear: () => {
				storeMap.clear();
			},
			all: () => Object.fromEntries(storeMap),
		},
		// ── 跨目录 fs：默认空白（= 插件没有 fs:read/未授权），单测用 overrides.fs 注入
		fs: {},
		// ── 插件数据目录（宿主给 <dataDir>/<pluginId>；单测必须注入临时目录）
		dataDir: "",
		getSettings: () => settingsState,
		// ── UI（内存注册表：同 id 覆盖；off 只摘本次注册的 id）
		ui: {
			register: (items) => {
				const list = Array.isArray(items) ? items : [items];
				const added = [];
				for (const raw of list.slice(0, 32)) {
					const id = raw && typeof raw.id === "string" && raw.id ? raw.id : `mock-ui-${added.length}`;
					uiItems.set(id, isPlainObject(raw) ? { ...raw, id } : { id });
					added.push(id);
				}
				let done = false;
				return () => {
					if (done) return;
					done = true;
					for (const id of added) uiItems.delete(id);
				};
			},
			update: (id, patch) => {
				if (!isPlainObject(patch)) return;
				uiUpdates.push({ id: String(id), patch: { ...patch } });
				if (!uiItems.has(id)) return;
				uiItems.set(id, { ...uiItems.get(id), ...patch, id });
			},
			remove: (id) => {
				uiItems.delete(id);
			},
			arrange: noop,
			list: () => ({ items: [...uiItems.values()], arrange: [] }),
		},
		// ── 路由 / 定时 / 后台任务 / effect
		route: (method, path, handler) =>
			remember(routeStore, { method: String(method ?? "GET").toUpperCase(), path: String(path ?? "/"), handler }),
		schedule: (spec, fn, opts) => remember(scheduleStore, { spec, fn, opts }),
		registerBackgroundTask: (task) => {
			const off = remember(bgTaskStore, task);
			return { update: noop, unregister: off };
		},
		effect: (label, dispose) => remember(effectStore, { label, dispose }),
		// ── 网络：默认不联网（需要时用 overrides.fetch 注入替身）
		fetch: async () => {
			throw new Error("[mock-host] fetch 未注入（单测不得联网）");
		},
		net: {
			fetch: async () => ({ ok: false, error: "mock：未注入 net" }),
		},
		log: logImpl,
		// ── 断言面
		calls,
		logs,
		mock: {
			get handlers() {
				const out = {};
				for (const [k, v] of handlerMap) out[k] = v;
				return out;
			},
			emit: (method, ...args) => {
				for (const h of [...(handlerMap.get(method) ?? [])]) h(...args);
			},
			calls: (method) => (method === undefined ? [...calls] : calls.filter((c) => c.method === method)),
			setSettings: (next) => {
				if (isPlainObject(next)) Object.assign(settingsState, next);
				return settingsState;
			},
			emitSettings: (next) => {
				if (isPlainObject(next)) Object.assign(settingsState, next);
				for (const h of [...(handlerMap.get("onSettingsChanged") ?? [])]) h(settingsState);
				return settingsState;
			},
			get routes() {
				return routeStore;
			},
			get schedules() {
				return scheduleStore;
			},
			get effects() {
				return effectStore;
			},
			get backgroundTasks() {
				return bgTaskStore;
			},
			get uiItems() {
				return [...uiItems.values()];
			},
			/** 最近的 ui.update 调用（按序；最后一个就是当前徽标状态）。 */
			get uiUpdates() {
				return [...uiUpdates];
			},
			/** 某个条目最后一次 update 的 patch（合并后的视图）。 */
			lastUiUpdate: (id) => {
				const hits = uiUpdates.filter((u) => u.id === id);
				return hits.length ? { ...hits[hits.length - 1].patch } : null;
			},
			/** 依次触发已登记的定时回调（返回各回调返回值；抛错即 reject）。 */
			fireSchedules: () => Promise.all(scheduleStore.map((s) => s.fn())),
		},
		reset: () => {
			calls.length = 0;
			logs.length = 0;
		},
	};

	// overrides：settings 单独处理；函数整体替换；命名空间对象按子键合并。
	for (const [key, value] of Object.entries(overrides)) {
		if (key === "settings") continue;
		if (key === "calls" || key === "logs" || key === "mock" || key === "reset") {
			throw new Error(`[mock-host] 不能覆盖 "${key}"（harness 自身字段）`);
		}
		if (NAMESPACES.includes(key) && isPlainObject(value) && isPlainObject(host[key])) {
			Object.assign(host[key], value);
		} else {
			host[key] = value;
		}
	}
	// 记录层：所有宿主方法先记 calls 再委托（log 也记，与真宿主一致）。
	const record =
		(method, fn) =>
		(...args) => {
			calls.push({ method, args, seq: calls.length });
			return fn(...args);
		};
	for (const [key, value] of Object.entries(host)) {
		if (key === "calls" || key === "logs" || key === "mock" || key === "reset") continue;
		if (typeof value === "function") host[key] = record(key, value);
		else if (NAMESPACES.includes(key) && isPlainObject(value)) {
			for (const [sk, fn] of Object.entries(value)) {
				if (typeof fn === "function") value[sk] = record(`${key}.${sk}`, fn);
			}
		}
	}
	return host;
}

export default createMockHost;
