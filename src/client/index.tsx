/**
 * v9 P1 记忆面板 — 右侧栏 tab 注册入口（浏览器半）。
 *
 * 照抄 dsh-context 的既有公开路径（client.js L13211 watchSidebarContextTab）：
 *   1. ctx.inject(["sidebarRightTabs"]) → tabs.register({id,kind,title,guide})
 *   2. slots.inject/register("sidebar.right.pane.tab", key→组件)
 *   3. slots.inject/register("sidebar.right.pane.tab.title", key→标题)
 *
 * 只在宿主提供 sidebarRightTabs 时才注册（老 harness 无此服务 → 静默跳过）。
 * P1：组件显示假数据；P2 接投影。
 */
import * as React from "react";
import { MemoryView } from "./MemoryView.tsx";
import { SettingsPage } from "./SettingsPage.tsx";

/** tab 类型身份（也是 body-seat 的 key）。命名空间化，避免与 dsh-context 撞名。 */
const PANEL_ID = "dsh-memory";
/** openTab 用的 kind。与 id 同名，同样命名空间化。 */
const PANEL_KIND = "dsh-memory";
/** 引导页入口排序：放在 dsh-context（20）之后。 */
const GUIDE_ORDER = 30;

/** 简单图标：一个方形 emoji 占位（P1 不引 primitives，P4 再换正式图标）。 */
function MemoryIcon() {
  return React.createElement("span", { style: { fontSize: 16 }, "aria-hidden": true }, "🧠");
}

/** tab chip 的标题组件。 */
function makeTabTitle() {
  return function TabTitle() {
    return React.createElement("span", null, "记忆");
  };
}

/**
 * 注册记忆 tab。返回 disposer。
 * @param ctx client root context（有 slots 与可选 sidebarRightTabs）。
 */
export function registerMemoryPanel(ctx: any) {
  const handle = ctx.inject(["sidebarRightTabs"], (injected: any) => {
    const disposers: Array<() => void> = [];
    const own = (r: any) => {
      if (typeof r === "function") disposers.push(r);
      else if (r && typeof r.dispose === "function") disposers.push(() => r.dispose());
    };
    try {
      const tabs = injected.sidebarRightTabs;
      if (tabs === undefined || typeof tabs.register !== "function") return;
      own(
        tabs.register({
          id: PANEL_ID,
          kind: PANEL_KIND,
          title: () => "记忆",
          guide: [
            {
              order: GUIDE_ORDER,
              title: () => "记忆",
              description: () => "上下文组成与长期记忆结构",
              icon: MemoryIcon,
            },
          ],
        }),
      );
      own(
        injected.slots.inject("sidebar.right.pane.tab", () =>
          injected.slots.register(
            { name: "sidebar.right.pane.tab", key: PANEL_ID },
            (props: any) => React.createElement(MemoryView, props),
          ),
        ),
      );
      own(
        injected.slots.inject("sidebar.right.pane.tab.title", () =>
          injected.slots.register({ name: "sidebar.right.pane.tab.title", key: PANEL_ID }, makeTabTitle()),
        ),
      );
    } catch {
      for (const d of disposers) d();
      return;
    }
    return () => {
      for (const d of disposers) d();
    };
  });
  return () => {
    handle?.dispose?.();
  };
}

/**
 * 插件 apply（浏览器半入口）。client 半约定：export { name, inject, apply }。
 * P1：只注册面板；后续可在此接投影订阅。
 *
 * 关键（P1 真机发现）：宿主加载 client 半时，**必须**看到 `name` 和 `inject`，
 * 否则不把它当作具名插件、不满足依赖、根本不 apply —— 表现为侧栏 tab 不出现。
 * 取证：dsh-context/lib/client.js 末尾 `module.exports = { name, inject:["slots","locale"], apply }`；
 * dsh-better-sidebar 末尾 `exports.inject = inject`（slots/sessions/locale/modules…）。
 * 我们注册右侧栏 tab 只需要 `slots`（sidebarRightTabs 由 ctx.inject 运行时拉取）。
 */
export const name = "dsh-memory";
export const inject = ["slots"];

export function apply(ctx: any) {
  registerMemoryPanel(ctx);
  registerSettingsSection(ctx);
}

/**
 * v11: register the settings page into the DSH Settings shell's
 * `settings.section` slot. The shell lives in another package, so `slots.inject`
 * waits for its declaration and silently no-ops on a deployment without the
 * settings surface. See SettingsPage.tsx for the transport (7788 fenced routes).
 */
function registerSettingsSection(ctx: any) {
  const register = () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "dsh-memory",
        order: 60,
        label: () => "记忆",
        inject: () => ({}),
      },
      (props: any) => React.createElement(SettingsPage, props),
    );
  ctx.slots.inject("settings.section", register);
}

