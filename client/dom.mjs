/**
 * 用量账本 v3 · DOM 小工具
 *
 * 看板的铁律是「骨架只建一次，之后按键打补丁」（docs §六）：
 *  - `h()/svgNode()` 只用于建骨架与节点池里的新节点；
 *  - `patch(root, values)` 按 `data-k` 写 textContent/属性/class，绝不整页 innerHTML；
 *  - `pool()` 做 keyed 复用（列表、表格行），同一 key 的节点被移动而不是重建，
 *    因此刷新不会丢失滚动位置与焦点。
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

function applyProps(node, props) {
	if (!props) return;
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
		if (key === "class") {
			node.setAttribute("class", String(value));
		} else if (key === "text") {
			node.textContent = String(value);
		} else if (key === "title") {
			node.setAttribute("title", String(value));
		} else if (key === "data") {
			for (const [k, v] of Object.entries(value)) node.setAttribute(`data-${k}`, String(v));
		} else if (key === "attrs") {
			for (const [k, v] of Object.entries(value)) {
				if (v !== null && v !== undefined) node.setAttribute(k, String(v));
			}
		} else if (key === "on") {
			for (const [k, fn] of Object.entries(value)) {
				if (typeof fn === "function") node.addEventListener(k, fn);
			}
		} else if (key === "style") {
			Object.assign(node.style, value);
		} else if (key === "value") {
			node.value = String(value);
		} else if (key === "hidden") {
			node.hidden = Boolean(value);
		} else if (key === "tabindex") {
			node.setAttribute("tabindex", String(value));
		} else if (key === "role") {
			node.setAttribute("role", String(value));
		} else if (key.startsWith("aria-")) {
			node.setAttribute(key, String(value));
		} else {
			node.setAttribute(key, String(value));
		}
	}
}

function appendChildren(node, children) {
	for (const child of children ?? []) {
		if (child === null || child === undefined || child === false) continue;
		node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
	}
}

/** 建 HTML 元素：`h("div", { class: "x", attrs: { "data-k": "a" } }, [child])`。 */
export function h(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	applyProps(node, props);
	appendChildren(node, children);
	return node;
}

/** 建 SVG 元素（必须用 createElementNS，否则不渲染）。 */
export function svgNode(tag, attrs = {}, children = []) {
	const node = document.createElementNS(SVG_NS, tag);
	if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
	appendChildren(node, children);
	return node;
}

/** 只在变化时写 textContent（避免无谓的样式重算与读屏重播）。 */
export function setText(node, value) {
	if (!node) return;
	const next = value === null || value === undefined ? "" : String(value);
	if (node.textContent !== next) node.textContent = next;
}

/** 只在变化时写属性。 */
export function setAttr(node, name, value) {
	if (!node) return;
	if (value === null || value === undefined || value === false) {
		if (node.hasAttribute(name)) node.removeAttribute(name);
		return;
	}
	const next = String(value);
	if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

function applyValue(node, value) {
	if (value === null || value === undefined || typeof value !== "object") {
		setText(node, value);
		return;
	}
	if ("text" in value) setText(node, value.text);
	if ("title" in value) setAttr(node, "title", value.title || null);
	if ("hidden" in value) {
		// 骨架里用 `cps-hidden` 类初始化隐藏态，补丁必须同时处理类，否则永远显示不出来
		const hidden = Boolean(value.hidden);
		node.hidden = hidden;
		node.classList.toggle("cps-hidden", hidden);
	}
	if ("disabled" in value) node.disabled = Boolean(value.disabled);
	if ("checked" in value) node.checked = Boolean(value.checked);
	if ("value" in value && "value" in node && node.type !== "checkbox") {
		const next = String(value.value ?? "");
		if (node.value !== next) node.value = next;
	}
	if (value.attrs) for (const [k, v] of Object.entries(value.attrs)) setAttr(node, k, v);
	if (value.data) for (const [k, v] of Object.entries(value.data)) setAttr(node, `data-${k}`, v);
	if (value.cls) for (const [k, on] of Object.entries(value.cls)) node.classList.toggle(k, Boolean(on));
	if (value.style) Object.assign(node.style, value.style);
}

const patchCache = new WeakMap();

/**
 * 按 `data-k` 打补丁。
 * @param {Element} root 骨架根
 * @param {Record<string, string|number|null|object>} values
 *   值可以是字符串（写 textContent），或 `{ text, title, hidden, disabled, value, cls, attrs, data, style }`
 * @returns {number} 实际写入的键数
 */
export function patch(root, values) {
	if (!root || !values) return 0;
	let cache = patchCache.get(root);
	if (!cache) {
		cache = new Map();
		patchCache.set(root, cache);
	}
	let count = 0;
	for (const key of Object.keys(values)) {
		let node = cache.get(key);
		if (node && !node.isConnected) {
			cache.delete(key);
			node = null;
		}
		if (!node) {
			node = root.querySelector(`[data-k="${key}"]`);
			if (!node) continue;
			cache.set(key, node);
		}
		applyValue(node, values[key]);
		count += 1;
	}
	return count;
}

/** 清空容器（只用于节点池容器，不用于整页）。 */
export function clear(node) {
	if (!node) return;
	while (node.firstChild) node.removeChild(node.firstChild);
}

function toNodeList(created) {
	if (!created) return [];
	return Array.isArray(created) ? created : [created];
}

/**
 * keyed 节点池：同 key 的节点被**原地复用**（不重建、不 detach）。
 *
 * 注意：不能「先全部塞进 DocumentFragment 再 appendChild」——那一步会把节点从文档里摘下，
 * 焦点（activeElement）与滚动位置随之丢失。这里逐个比对目标位置，只在需要时移动。
 * @param {Element} container
 * @param {Array} items
 * @param {{key: (item:any)=>string, create: (item:any)=>Node|Node[], update?: (nodes:Node[], item:any)=>void}} opts
 */
export function pool(container, items, opts) {
	if (!container) return;
	const store = container.__cpsPool instanceof Map ? container.__cpsPool : new Map();
	const next = new Map();
	const flat = [];
	for (const item of items ?? []) {
		const key = String(opts.key(item));
		let nodes = next.get(key) ?? store.get(key) ?? null;
		if (!nodes) nodes = toNodeList(opts.create(item));
		if (opts.update) opts.update(nodes, item);
		next.set(key, nodes);
		for (const node of nodes) flat.push(node);
	}
	// 按目标顺序逐个就位：已经在对的位置就跳过（不 detach）
	let cursor = container.firstChild;
	for (const node of flat) {
		if (node === cursor) {
			cursor = cursor.nextSibling;
			continue;
		}
		container.insertBefore(node, cursor);
	}
	// cursor 之后剩下的都是本轮不该有的节点
	while (cursor) {
		const after = cursor.nextSibling;
		container.removeChild(cursor);
		cursor = after;
	}
	store.clear();
	for (const [key, nodes] of next) store.set(key, nodes);
	container.__cpsPool = store;
}
