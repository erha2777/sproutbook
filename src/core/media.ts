/**
 * 背景图选择的纯逻辑。
 *
 * 抽出来的原因：这段判断在 1.36 出过一次「选完背景反而没背景」的问题 ——
 * 当偏好指向的文件没出现在列表里（转换失败、扫描时文件被占用、列表还没加载完），
 * 原来的写法会返回空数组，`<Backdrop>` 收到空数组就整个不渲染，
 * 于是露出主题自带的兜底画面，看起来像"背景没了"。
 *
 * 现在的规矩：**永远不要因为一个解析不出来的偏好把背景清空**。
 * 找不到选中的那张就退回"全部轮播"，至少背景还在。
 */

/** 偏好值：只用主题自带的背景（不带上传的） */
export const THEME_BACKDROP = '__theme__'

export interface BackdropItem {
  name: string
  url: string
}

/**
 * @param base      主题自带的背景（theme.json 的 backgrounds，已转 data URL）
 * @param uploaded  用户上传的背景
 * @param pref      设置里存的选择：null = 全部轮播；THEME_BACKDROP = 只主题；否则是文件名
 * @param directUrl 偏好那张单独取到的 URL（列表里没有时的补救），没有就传 null
 */
export function resolveBackdrops(
  base: string[],
  uploaded: BackdropItem[],
  pref: string | null,
  directUrl?: string | null
): string[] {
  if (pref === THEME_BACKDROP) return base
  if (pref) {
    const hit = uploaded.find((item) => item.name === pref)
    if (hit) return [hit.url]
    if (directUrl) return [directUrl]
    // 找不到就退回全部：宁可显示别的，也不要一片空白
  }
  return [...base, ...uploaded.map((item) => item.url)]
}
