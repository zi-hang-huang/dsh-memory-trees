/**
 * dsh-memory 客户端半构建（v9）。
 *
 * 产出 lib/client.js，形态为 window.__ModuleLoader__.load({ id, factory })，可被
 * dsh-client-modules 的加载器物化。P0 已实测该形态成立（见 v9-记忆面板插件方案 §4.1）。
 *
 * 关键：
 *   - 不 import defineConfig（npx 临时安装解析不到 tsdown 包），直接导出普通对象。
 *   - format: cjs + banner/footer 包出 factory 外壳。
 *   - outExtensions 强制产物名为 client.js（默认会是 .cjs）。
 *   - react / react/jsx-runtime 以及所有 @deepseek-ai/* 宿主模块 neverBundle（走 require）。
 */
export default {
  entry: { client: "src/client/index.tsx" },
  format: "cjs",
  outDir: "lib",
  platform: "browser",
  dts: false,
  clean: false,
  // 宿主提供这些模块；bundle 只 require，不内联。
  deps: {
    neverBundle: [/^react($|\/)/, /^@deepseek-ai\//],
  },
  outExtensions: () => ({ js: ".js" }),
  outputOptions: {
    banner: `window.__ModuleLoader__.load({\n\tid: "dsh-memory",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;`,
    footer: `\n\t\treturn module.exports;\n\t}\n});`,
  },
};
