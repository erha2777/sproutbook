/**
 * CSV 编解码 —— 纯函数，不碰文件系统。
 *
 * 为什么自己写而不引依赖：导出导入是这个应用**唯一的数据出口**，
 * 格式上出一点偏差（引号、换行、BOM）就会让用户拿到的文件在 Excel 里错位。
 * 与其信任一个未审计的依赖，不如把 RFC 4180 老老实实实现一遍并写自检钉住。
 *
 * 支持的规则（RFC 4180）：
 *  - 字段含 `,` `"` CR 或 LF 时，整体用双引号包裹
 *  - 字段内的 `"` 写成 `""`
 *  - 记录之间用 CRLF 或 LF 分隔（解析时两者都认）
 *  - 忽略文件头部的 UTF-8 BOM（Excel 导出常见）
 */

/** 需要加引号的字符 */
const NEEDS_QUOTE = /[",\r\n]/

/** 把一个字段值编码成 CSV 字段（必要时加引号并转义内部引号）。 */
export function encodeCsvField(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (!NEEDS_QUOTE.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}

/**
 * 序列化为 CSV 文本。
 *
 * @param headers 列顺序（同时作为表头）
 * @param rows    每行的取值函数或对象；缺失的列写空
 */
export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines: string[] = [headers.map(encodeCsvField).join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => encodeCsvField(row[h])).join(','))
  }
  // 结尾换行：Excel 与多数工具都接受，且避免最后一行被截断的歧义
  return `${lines.join('\r\n')}\r\n`
}

export interface CsvTable {
  headers: string[]
  /** 每行的字段值，长度与 headers 对齐（不足补空字符串） */
  rows: string[][]
}

/**
 * 解析 CSV 文本。
 *
 * 逐字符状态机，而不是按行 split —— 因为带引号的字段里可以合法地包含换行，
 * 先按行切会直接把这种字段切碎。
 */
export function parseCsv(input: string): CsvTable {
  // 去掉 BOM：Excel 与部分导出工具会加，留着会让第一个表头匹配不上
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    rows.push(row)
    row = []
  }

  while (i < text.length) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        // 连续两个引号 = 一个字面引号；否则是字段结束
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      endField()
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      // CRLF 当作一个换行
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
      i++
      continue
    }
    field += ch
    i++
  }

  // 收尾：文件不以换行结束时，最后一行也要收进来
  if (field !== '' || row.length > 0) endRow()

  // 丢掉完全空白的行（末尾换行、以及只有分隔逗号的空行）
  const cleaned = rows.filter((r) => r.some((c) => c.trim() !== ''))
  if (cleaned.length === 0) return { headers: [], rows: [] }

  const [headers, ...dataRows] = cleaned
  return {
    headers: headers.map((h) => h.trim()),
    rows: dataRows.map((r) => {
      // 补齐到表头长度，避免下游到处判 undefined
      const out = r.slice(0, headers.length)
      while (out.length < headers.length) out.push('')
      return out
    })
  }
}
