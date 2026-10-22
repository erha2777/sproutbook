/**
 * 可搜索下拉的纯逻辑（显示什么、回车选什么）。
 *
 * 抽出来的原因是一个真实 bug：允许自定义的输入框里敲了新分类、按回车，
 * 数据其实写进去了，但收起的输入框用 `options.find(value)` 找显示文字 ——
 * 新值还不在选项里，于是 find 返回空、输入框变空白，看起来就像"回车没生效"。
 *
 * 这类"取值 → 显示/采纳"的判断一旦错就很难看出来，所以放到 core 里用自检钉住。
 */

export interface SearchOption {
  value: string
  label: string
}

export interface SearchSelectViewInput {
  /** 当前值（可能是选项之外的自由值） */
  value: string
  /** 输入框里正在打的字（展开时才有意义） */
  query: string
  open: boolean
  options: SearchOption[]
  /** 允许把输入的文字当新值（分类这类"用户可以造词"的字段） */
  allowCustom: boolean
}

export interface SearchSelectView {
  /** 收起时输入框显示的文字 */
  display: string
  /** 展开时按 query 过滤后的选项 */
  filtered: SearchOption[]
  /** 菜单顶部那条「使用「xxx」」，null 表示不值得显示 */
  customCandidate: string | null
  /** 回车采纳的值；null = 这次回车什么都不做 */
  enterPick: string | null
}

export function searchSelectView(input: SearchSelectViewInput): SearchSelectView {
  const { value, query, open, options, allowCustom } = input
  const q = query.trim()
  const selected = options.find((o) => o.value === value) ?? null

  // 收起的显示：优先用选项里的 label；自定义值直接显示它自己，绝不显示空
  const display = open ? query : (selected?.label ?? (allowCustom ? value : ''))

  const filtered = !q ? options : options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))

  const customCandidate =
    allowCustom && q && !options.some((o) => o.label === q || o.value === q) ? q : null

  /*
   * 回车选什么。顺序是：完全匹配 → 过滤后的第一项 → 自定义值。
   *
   * 「第一项优先于自定义」是刻意的：打「月」想找「月季」时按回车，
   * 结果造出一个叫「月」的新分类，比"得再点一下「使用『月』」"糟糕得多。
   * 真想造新词时，输入的内容通常已经和现有项不匹配了（列表为空）。
   */
  let enterPick: string | null = null
  if (open && q) {
    const exact = options.find((o) => o.label === q || o.value === q)
    if (exact) enterPick = exact.value
    else if (filtered.length > 0) enterPick = filtered[0].value
    else if (customCandidate) enterPick = customCandidate
  }

  return { display, filtered, customCandidate, enterPick }
}
