/**
 * 首次启动的种子数据：默认信息模板 + 一个示例环境档案。
 *
 * 幂等：重复调用不会产生重复字段（按键名判重）。
 */

import { Db } from './connection'
import { defaultFieldDefinitions, SYSTEM_COLUMNS } from '../../core/defaultTemplate'
import type { NewFieldDefinition } from '../../core/types'

export function seedFieldDefinitions(db: Db): { inserted: number; skipped: number } {
  const defs = defaultFieldDefinitions()
  let inserted = 0
  let skipped = 0

  db.transaction(() => {
    /**
     * 新字段插到哪里。
     *
     * 两个坑：
     *  1. 不能用「插入计数」当序号 —— 给已有库补字段时，被跳过的老字段不占号，
     *     新字段会拿到 0、1、2 撞上老字段，排序只能靠 id 兜底（那是巧合不是设计）。
     *  2. 也不能简单地追加到末尾 —— 升级用户会看到「所属物种 / 养护位置 / 状态」
     *     被排到「备注」后面，而这些恰恰是最常用的字段。
     *
     * 做法：按字段在模板里的规范序号插入，并把该位置及其后的已有字段整体后移一格。
     * 这样新字段落在正确位置，已有字段的**相对次序保持不变**，也没有并列。
     */
    const canonicalIndex: Record<string, number> = { species: 0, plant: 0 }

    for (const def of defs) {
      // 规范序号对「插入的」和「跳过的」都要推进，否则序号会整体前移
      const wanted = canonicalIndex[def.ownerKind] ?? 0
      canonicalIndex[def.ownerKind] = wanted + 1

      const existing = db.get<{ id: number }>(
        'SELECT id FROM field_definitions WHERE owner_kind = ? AND key = ?',
        def.ownerKind,
        def.key
      )
      if (existing) {
        skipped++
        continue
      }

      // 让位：把该位置及其后的字段整体后移一格
      db.run(
        'UPDATE field_definitions SET sort_order = sort_order + 1 WHERE owner_kind = ? AND sort_order >= ?',
        def.ownerKind,
        wanted
      )

      insertFieldDefinition(db, def, wanted)
      inserted++
    }
  })

  return { inserted, skipped }
}

export function insertFieldDefinition(db: Db, def: NewFieldDefinition, sortOrder: number): number {
  const columnName = SYSTEM_COLUMNS[def.key] ?? null
  const isSystem = columnName ? 1 : 0
  const r = db.run(
    `INSERT INTO field_definitions
       (owner_kind, key, label, label_en, group_name, type, unit, options_json, default_json,
        help_text, is_system, is_required, is_safety, column_name, relation_target,
          visible_when_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    def.ownerKind,
    def.key,
    def.label,
    def.labelEn ?? null,
    def.groupName,
    def.type,
    def.unit ?? null,
    def.options ? JSON.stringify(def.options) : null,
    def.defaultValue === undefined ? null : JSON.stringify(def.defaultValue),
    def.helpText ?? null,
    isSystem,
    def.isRequired ? 1 : 0,
    def.isSafety ? 1 : 0,
    columnName,
    def.relationTarget ?? null,
    def.visibleWhen ? JSON.stringify(def.visibleWhen) : null,
    sortOrder
  )
  return Number(r.lastInsertRowid)
}

export function seedEnvironments(db: Db): number {
  const existing = db.scalar<number>('SELECT COUNT(*) AS c FROM environments')
  if (Number(existing ?? 0) > 0) return 0

  const rows: Array<[string, string, string, number, number]> = [
    ['南向阳台', 'balcony', 'full_sun', 6, 1],
    ['北向窗台', 'indoor', 'shade', 1, 0],
    ['露台', 'terrace', 'full_sun', 8, 0],
    ['室内补光', 'indoor', 'part_shade', 4, 1]
  ]
  db.transaction(() => {
    rows.forEach((r, i) => {
      db.run(
        `INSERT INTO environments (name, kind, light_level, light_hours, frost_protected, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        r[0],
        r[1],
        r[2],
        r[3],
        r[4],
        i
      )
    })
  })
  return rows.length
}

/**
 * 养护规则库的初始内容。
 *
 * 规则只写到「哪个月做什么」，不写具体哪天 —— 「3~5 月每月施一次薄肥」是知识，
 * 「3 月 15 日施肥」是排期，后者取决于天气和你什么时候有空。
 * 生成任务时会给一个时间窗，窗口内做都算准时。
 *
 * `species_key` 为 `'*'` 的是通用规则，其余按物种名匹配。这些只是起点：
 * 用户可以改、可以删、也可以加自己摸索出来的经验。
 */
export function seedCareRules(db: Db): number {
  const existing = db.scalar<number>('SELECT COUNT(*) AS c FROM care_rules')
  if (Number(existing ?? 0) > 0) return 0

  interface SeedRule {
    species: string
    from: number
    to: number | null
    action: string
    title: string
    detail: string
    priority: number
    /** 重复间隔（天）。留空＝区间内每月一条 */
    repeatDays?: number
    /** 轮换步骤，生成时按顺序循环 */
    rotation?: string[]
    /** 所有植株同一天做（不按植株错开） */
    sameDay?: boolean
  }

  const rows: SeedRule[] = [
    // ---- 通用：所有植物都适用 ----
    { species: '*', from: 3, to: null, action: 'repot', title: '春季换盆', detail: '根系长满盆或土已板结时换盆，顺便修掉烂根、换新土。', priority: 3 },
    {
      species: '*',
      from: 3,
      to: 6,
      action: 'fertilize',
      title: '生长期追肥',
      // 真实的追肥不是「每月一次」，而是「7~10 天一轮、几种肥轮换」。
      // 一轮 = 一次浇灌，不是连续浇三种；海藻/腐植酸穿插增效，不能长期替代主肥。
      detail: '7~10 天一轮，薄肥勤施。一轮只浇一种，按轮换顺序来。持续 35℃ 以上暂停花多多，只留海藻精抗逆，不施氮肥。',
      priority: 2,
      repeatDays: 8,
      rotation: ['花多多1号', '海藻精', '腐植酸水溶肥']
    },
    { species: '*', from: 3, to: 5, action: 'pest', title: '春季防虫', detail: '新芽期注意蚜虫、红蜘蛛。发现就隔离处理，别等蔓延。', priority: 3 },
    { species: '*', from: 6, to: 8, action: 'water', title: '夏季勤浇水', detail: '高温蒸发快，见干见湿；避开正午浇水，早晚为宜。', priority: 2 },
    { species: '*', from: 6, to: 8, action: 'protect', title: '夏季遮阴', detail: '正午强光适当遮阴，防止叶片灼伤；同时注意通风。', priority: 3 },
    {
      species: '*',
      from: 6,
      to: 8,
      action: 'fertilize',
      title: '花芽分化期追肥',
      detail: '停用高氮肥（花多多1号、豆粕）。改用磷酸二氢钾（首选，纯度高性价比好）或花多多2号，保花芽、防落蕾。花苞显色开放后全部停肥。',
      priority: 2
    },
    { species: '*', from: 9, to: 10, action: 'fertilize', title: '秋季补肥', detail: '花期后补一次磷钾肥，帮助积累养分越冬。', priority: 2 },
    { species: '*', from: 11, to: null, action: 'protect', title: '入冬防冻', detail: '不耐寒的搬进室内或加保温。留意夜间最低温。', priority: 1 },
    { species: '*', from: 11, to: 2, action: 'water', title: '冬季控水', detail: '低温期生长慢，浇水频率要降下来，盆土偏干更安全。落叶休眠后所有水溶追肥停止。', priority: 2 },
    { species: '*', from: 12, to: null, action: 'observe', title: '年终检查', detail: '检查冻伤、介壳虫，清理枯叶，回顾这一年哪些养得好。', priority: 3 },
    { species: '*', from: 11, to: null, action: 'other', title: '地表覆盖', detail: '铺 2~3cm 生松针（不要埋进土里），保水抑草，缓慢酸化表层土壤。', priority: 3 },

    // ---- 月季 ----
    { species: '月季', from: 2, to: null, action: 'prune', title: '冬季重剪', detail: '落叶后重剪，保留 3~5 个主枝，剪口留在饱满芽上方。', priority: 1 },
    { species: '月季', from: 4, to: 6, action: 'pest', title: '月季防黑斑病', detail: '雨季前预防性喷药，发现病叶立即摘除并清理落叶。', priority: 2 },
    // 秋埋底肥是一年一次、要一次把几盆都处理掉的事 → 所有植株同一天
    { species: '月季', from: 11, to: null, action: 'fertilize', title: '秋埋底肥', detail: '羊粪为主 + 缓释肥 + 少量骨粉，沿盆边埋入。', priority: 2, sameDay: true },

    // ---- 多肉 ----
    { species: '玉露', from: 7, to: 8, action: 'protect', title: '多肉度夏', detail: '高温休眠，严格控水、遮阴、加强通风，闷热比干旱更致命。', priority: 1 },
    { species: '玉露', from: 12, to: 2, action: 'protect', title: '多肉防冻', detail: '低于 5℃ 搬进室内，基本断水越冬。', priority: 1 },
    { species: '玉露', from: 3, to: 5, action: 'water', title: '多肉生长期浇水', detail: '生长季可以正常浇水，干透浇透。', priority: 2 },

    // ---- 绿萝 ----
    { species: '绿萝', from: 5, to: 9, action: 'fertilize', title: '绿萝生长期追肥', detail: '每 2 周一次观叶植物液肥，氮肥为主。', priority: 3 },
    { species: '绿萝', from: 10, to: 4, action: 'water', title: '绿萝控水', detail: '气温低时减少浇水，盆土过湿容易烂根黄叶。', priority: 2 }
  ]

  db.transaction(() => {
    for (const r of rows) {
      db.run(
        `INSERT INTO care_rules (species_key, hemisphere, month_from, month_to,
           repeat_days, rotation_json, same_day, action_type, title, detail, priority, source, verified)
         VALUES (?, 'N', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', 1)`,
        r.species,
        r.from,
        r.to,
        r.repeatDays ?? null,
        r.rotation ? JSON.stringify(r.rotation) : null,
        // 默认同一天：种子规则也不再按植株错开（用户要的是规律）
        r.sameDay === false ? 0 : 1,
        r.action,
        r.title,
        r.detail,
        r.priority
      )
    }
  })
  return rows.length
}

export function seedAll(db: Db): { fields: number; environments: number; careRules: number } {
  const fields = seedFieldDefinitions(db)
  const environments = seedEnvironments(db)
  const careRules = seedCareRules(db)
  return { fields: fields.inserted, environments, careRules }
}
