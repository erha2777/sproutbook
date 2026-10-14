/**
 * electron-builder 的 beforeBuild 钩子。
 *
 * 返回 `false` 的含义（见 app-builder-lib/packager.js）：
 *   「node_modules 由我们自己处理，electron-builder 不需要收集和打包它。」
 *
 * 这对本项目是**准确**的，不是绕过：
 *   - package.json 的 dependencies 为空；
 *   - 所有主进程 / preload / 渲染层代码都由 electron-vite 打包进 `out/`；
 *   - 因此最终应用里根本不需要任何 node_modules。
 *
 * 同时它也规避了一个实际故障：electron-builder 26 会调用 `pnpm list --json`
 * 来收集依赖树，而 pnpm 11 会在 JSON 前后打印供应链校验横幅，
 * 导致解析失败并报 "No JSON content found in output"。
 *
 * 如果将来引入了**运行时**依赖（即需要真实存在于 node_modules 里的包），
 * 就必须删掉 electron-builder.yml 里的 beforeBuild 配置，并改用
 * electron-builder 的依赖收集流程 —— 否则那些依赖不会被打进安装包。
 */

/** @returns {Promise<boolean>} false = 不执行依赖安装与收集 */
module.exports.beforeBuild = async function beforeBuild() {
  // eslint-disable-next-line no-console
  console.log('[before-build] 无运行时依赖，跳过 node_modules 收集（代码已全部打包进 out/）')
  return false
}
