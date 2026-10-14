/**
 * 数据库结构定义（迁移即历史，只增不改）。
 *
 * 规则：
 *  1. 已发布的迁移**永不修改**，需要变更就追加新版本。
 *  2. 所有时间字段用 TEXT 存 ISO 字符串（SQLite 没有原生日期类型）。
 *  3. 软删除优先：能归档就不物理删除，避免用户误操作丢数据。
 */

import type { Db } from './connection'

export interface Migration {
  version: number
  name: string
  /** 结构变更写在这里 */
  sql?: string
  /**
   * 需要**改数据**的迁移（比如某个字段的取值形状变了）写在这里。
   * 与 sql 在同一个事务里执行，失败即整体回滚。
   */
  run?: (db: Db) => void
}

const V1_INIT = /* sql */ `
-- 设置：AI 配置、界面偏好等（密钥不在这里，走系统钥匙串）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 环境档案：位置 / 光照 / 气候，被多株植株引用
CREATE TABLE environments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'balcony',
  light_level      TEXT,
  light_hours      REAL,
  climate_zone     TEXT,
  province         TEXT,
  city             TEXT,
  lat              REAL,
  lon              REAL,
  can_heat         INTEGER NOT NULL DEFAULT 0,
  frost_protected  INTEGER NOT NULL DEFAULT 0,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  archived_at      TEXT
);

-- 模板字段定义：用户可编辑的信息模板
CREATE TABLE field_definitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_kind    TEXT NOT NULL,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  label_en      TEXT,
  group_name    TEXT NOT NULL DEFAULT '其他',
  type          TEXT NOT NULL,
  unit          TEXT,
  options_json  TEXT,
  default_json  TEXT,
  help_text     TEXT,
  is_system     INTEGER NOT NULL DEFAULT 0,
  is_required   INTEGER NOT NULL DEFAULT 0,
  is_safety     INTEGER NOT NULL DEFAULT 0,
  column_name   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT,
  UNIQUE (owner_kind, key)
);
CREATE INDEX idx_field_defs_owner ON field_definitions(owner_kind, sort_order);

-- 材料：配土 / 肥料 / 药剂的组成成分
CREATE TABLE materials (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  kind  TEXT NOT NULL DEFAULT 'substrate',
  unit  TEXT,
  note  TEXT
);

-- 配方：配土、肥料、药剂
CREATE TABLE recipes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT '配土',
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE TABLE recipe_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id   INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  name        TEXT,
  ratio_part  REAL,
  amount      REAL,
  unit        TEXT,
  note        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_recipe_items ON recipe_items(recipe_id, sort_order);

-- 物种库（知识层）：可由 AI 补全，可被多株植株引用
CREATE TABLE species (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  common_name      TEXT NOT NULL,
  scientific_name  TEXT,
  family           TEXT,
  genus            TEXT,
  aliases_json     TEXT NOT NULL DEFAULT '[]',
  attributes_json  TEXT NOT NULL DEFAULT '{}',
  source           TEXT NOT NULL DEFAULT 'manual',
  confidence_json  TEXT NOT NULL DEFAULT '{}',
  verified_json    TEXT NOT NULL DEFAULT '[]',
  search_blob      TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at      TEXT
);
CREATE INDEX idx_species_name   ON species(common_name);
CREATE INDEX idx_species_family ON species(family);
CREATE INDEX idx_species_search ON species(search_blob);

-- 我的植株（实例层）
CREATE TABLE plants (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  species_id          INTEGER REFERENCES species(id) ON DELETE SET NULL,
  nickname            TEXT NOT NULL,
  env_id              INTEGER REFERENCES environments(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'growing',
  acquired_at         TEXT,
  pot_size            TEXT,
  substrate_recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
  attributes_json     TEXT NOT NULL DEFAULT '{}',
  notes               TEXT,
  cover_image_id      INTEGER,
  search_blob         TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at         TEXT
);
CREATE INDEX idx_plants_species ON plants(species_id);
CREATE INDEX idx_plants_env     ON plants(env_id);
CREATE INDEX idx_plants_status  ON plants(status);
CREATE INDEX idx_plants_search  ON plants(search_blob);

-- 图片：只存相对路径，文件放 userData/images，绝不进数据库、不进 git
CREATE TABLE images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id   INTEGER REFERENCES plants(id) ON DELETE CASCADE,
  species_id INTEGER REFERENCES species(id) ON DELETE CASCADE,
  task_id    INTEGER,
  path       TEXT NOT NULL,
  thumb_path TEXT,
  width      INTEGER,
  height     INTEGER,
  caption    TEXT,
  taken_at   TEXT,
  origin     TEXT NOT NULL DEFAULT 'user',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_images_plant   ON images(plant_id, sort_order);
CREATE INDEX idx_images_species ON images(species_id, sort_order);

-- 养护计划
CREATE TABLE care_plans (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id             INTEGER REFERENCES plants(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  year                 INTEGER,
  source               TEXT NOT NULL DEFAULT 'manual',
  climate_snapshot_json TEXT,
  rule_version         TEXT,
  prompt_version       TEXT,
  status               TEXT NOT NULL DEFAULT 'active',
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 养护任务
CREATE TABLE care_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id        INTEGER REFERENCES care_plans(id) ON DELETE CASCADE,
  plant_id       INTEGER REFERENCES plants(id) ON DELETE CASCADE,
  action_type    TEXT NOT NULL DEFAULT 'observe',
  title          TEXT NOT NULL,
  detail         TEXT,
  due_date       TEXT NOT NULL,
  window_days    INTEGER NOT NULL DEFAULT 3,
  recurrence     TEXT,
  priority       INTEGER NOT NULL DEFAULT 2,
  status         TEXT NOT NULL DEFAULT 'pending',
  completed_at   TEXT,
  completed_note TEXT,
  source         TEXT NOT NULL DEFAULT 'manual',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_due   ON care_tasks(status, due_date);
CREATE INDEX idx_task_plant ON care_tasks(plant_id, due_date);

-- 物种养护规则库：先有规则，AI 只用来补规则，不用来生成日历
CREATE TABLE care_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  species_key  TEXT NOT NULL,
  hemisphere   TEXT NOT NULL DEFAULT 'N',
  climate_zone TEXT,
  month_from   INTEGER NOT NULL,
  month_to     INTEGER,
  action_type  TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT,
  priority     INTEGER NOT NULL DEFAULT 2,
  source       TEXT NOT NULL DEFAULT 'seed',
  verified     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rule_lookup ON care_rules(species_key, hemisphere, month_from);

-- 养护日志：时间线与将来「生长展现」的数据源
CREATE TABLE care_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id   INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  task_id    INTEGER,
  log_date   TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note',
  content    TEXT,
  image_id   INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_logs_plant ON care_logs(plant_id, log_date);

-- 属性索引投影：可从 JSON 全量重建，只用于筛选 / 排序 / 统计
CREATE TABLE attr_index (
  owner_kind TEXT NOT NULL,
  owner_id   INTEGER NOT NULL,
  field_key  TEXT NOT NULL,
  idx        INTEGER NOT NULL DEFAULT 0,
  value_text TEXT,
  value_num  REAL,
  value_date TEXT,
  PRIMARY KEY (owner_kind, owner_id, field_key, idx)
) WITHOUT ROWID;
CREATE INDEX idx_attr_text ON attr_index(field_key, value_text);
CREATE INDEX idx_attr_num  ON attr_index(field_key, value_num);

-- AI 调用审计：出问题时能知道「它当时到底收到了什么」
CREATE TABLE ai_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL,
  provider          TEXT,
  model             TEXT,
  base_url          TEXT,
  prompt_version    TEXT,
  input_json        TEXT,
  output_json       TEXT,
  status            TEXT NOT NULL DEFAULT 'ok',
  error             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  duration_ms       INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_runs_kind ON ai_runs(kind, created_at);
`

const V2_RELATION_FIELDS = /* sql */ `
-- 「所属物种」「养护位置」这类字段原本硬编码在表单里，无法像其它字段一样
-- 调整位置 / 改标签 / 换分组 —— 与「字段是数据不是代码」的设计自相矛盾。
-- 新增 relation 类型让它们进模板；目标表存在这一列里。
ALTER TABLE field_definitions ADD COLUMN relation_target TEXT;
`

/**
 * 把 month_range 字段的值从「单个区间」改写成「月份集合」。
 *
 * 起因：很多植物一年开两次（月季 4~6 月 + 9~11 月），夏天和冬天各休眠一次的也不少，
 * 而 {from,to} 只能表达一段连续区间，模型上就是错的。
 *
 * 读取端（normalizeMonths）两种形状都认，所以这个迁移不是「必须成功才能用」，
 * 而是把存量数据统一成新形状，避免库里长期存在两种表示。
 */
function migrateMonthRangesToSets(db: Db): void {
  const defs = db.all<{ owner_kind: string; key: string }>(
    "SELECT owner_kind, key FROM field_definitions WHERE type = 'month_range'"
  )
  if (defs.length === 0) return

  const tables: Record<string, string> = { species: 'species', plant: 'plants' }

  const expand = (from: number, to: number): number[] => {
    const out: number[] = []
    let cur = from
    for (let i = 0; i < 12; i++) {
      out.push(cur)
      if (cur === to) break
      cur = cur === 12 ? 1 : cur + 1
    }
    return out
  }

  for (const def of defs) {
    const table = tables[def.owner_kind]
    if (!table) continue

    for (const row of db.all<{ id: number; attributes_json: string | null }>(
      `SELECT id, attributes_json FROM ${table}`
    )) {
      let attrs: Record<string, unknown>
      try {
        attrs = JSON.parse(row.attributes_json ?? '{}') as Record<string, unknown>
      } catch {
        continue // 坏 JSON 交给投影重建去处理，不在这里抛错中断整个迁移
      }

      const value = attrs[def.key]
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue

      const r = value as { from?: unknown; to?: unknown }
      if (typeof r.from !== 'number' || typeof r.to !== 'number') continue

      attrs[def.key] = expand(r.from, r.to)
      db.run(`UPDATE ${table} SET attributes_json = ? WHERE id = ?`, JSON.stringify(attrs), row.id)
    }
  }
}

/**
 * 周期任务：让「每 7~10 天一轮」这种节奏能被表达出来。
 *
 * 起因：真实的施肥方案不是「每月一次」，而是「7~10 天一轮，三种肥循环」。
 * 原来的规则只能按月份触发、一个月只产出一条任务，表达不了这种节奏 ——
 * 而 care_tasks.recurrence 那一列从一开始就是为它准备的，只是没人接上线。
 *
 * repeat_days 为空时保持原行为（区间内每月一条）；
 * 非空时按天数在区间内重复排布。
 * rotation_json 是轮换步骤数组，生成时按顺序取名，例如
 * ["花多多1号","海藻精","腐植酸水溶肥"]。
 */
const V4_CARE_CYCLE = /* sql */ `
ALTER TABLE care_rules ADD COLUMN repeat_days INTEGER;
ALTER TABLE care_rules ADD COLUMN rotation_json TEXT;
`

/**
 * 物候阶段：让「什么时候停」能被表达出来。
 *
 * 起因：用户的施肥方案里有三处停用条件 ——「花芽分化期停用所有高氮肥」
 * 「花苞显色开放后全部停肥」「冬季落叶休眠后所有水溶追肥全部停止」。
 * 而规则原只能「增加」任务，不能「抑制」。
 *
 * 做法上有一个取舍：**不单独做一套「停用规则」**，而是给规则加
 * active_phases（限定生效阶段）。于是「休眠期停止水溶追肥」就变成
 * 「这条追肥规则只在生长期/花芽分化期生效」—— 停用是限定生效阶段的
 * 自然结果，不需要第二张表和第二套冲突解决逻辑。
 *
 * 阶段是「观察到的状态」而不是月份，所以记在植株上，由人来标记。
 * 没标记阶段时一切照旧按月份走，不会影响现有用法。
 */
const V5_PHASES = /* sql */ `
ALTER TABLE care_rules ADD COLUMN active_phases TEXT;
ALTER TABLE plants ADD COLUMN phase TEXT;
ALTER TABLE plants ADD COLUMN phase_changed_at TEXT;
`

/**
 * 规则的适用物种从单值改成数组。
 *
 * 起因：用户真实的底肥方案里，多个物种共用一套配比
 * （「绣球、无花果、月季」一套，「杜鹃、中华木绣球、三角梅」另一套）。
 * 单值逼出了「一物种一条规则」，改一次配比要改好几处。
 *
 * 旧数据是纯字符串（物种名或 '*'），读写两端都能兼容，
 * 这里只是把它统一成 JSON 数组形式，方便排查和后续查询。
 */
const V6_MULTI_SPECIES = /* sql */ `
UPDATE care_rules
   SET species_key = json_array(species_key)
 WHERE species_key IS NOT NULL
   AND species_key <> ''
   AND species_key NOT LIKE '[%';
`

/**
 * 字段的条件显示。
 *
 * 「盆径」只在栽种方式是盆栽时有意义，「中毒症状」只在毒性等级不是无毒时有意义。
 * 无条件地摆在表单上，一半时间是噪音。
 *
 * 存成 JSON 而不是拆成两列（依赖字段 + 取值列表）：条件形态以后可能变
 * （比如「非空时」「大于某值」），JSON 不用再迁移一次。
 */
const V7_FIELD_VISIBILITY = /* sql */ `
ALTER TABLE field_definitions ADD COLUMN visible_when_json TEXT;
`

/**
 * 盆径从「单行文本」改成「数字（厘米）」。
 *
 * 旧字段 key 是 pot_size、类型 text，值像 "25cm"；新字段是 pot_size_cm、
 * 类型 number。种子里只加不减，所以必须显式归档旧的，
 * 否则用户会看到两个「盆径」。
 *
 * 值搬迁要做字符串到数字的解析（"25cm" → 25），SQL 里写太脆，
 * 用 TS 回调逐条搬。
 */
function migratePotSize(db: Db): void {
  const oldDef = db.get<{ id: number; key: string }>(
    "SELECT id, key FROM field_definitions WHERE owner_kind = 'plant' AND key = 'pot_size'"
  )
  if (!oldDef) return

  // 1) 把旧字段里的数值搬到新字段
  const rows = db.all<{ id: number; attributes_json: string | null }>(
    'SELECT id, attributes_json FROM plants WHERE attributes_json IS NOT NULL'
  )
  for (const row of rows) {
    let attrs: Record<string, unknown>
    try {
      attrs = JSON.parse(row.attributes_json ?? '{}') as Record<string, unknown>
    } catch {
      continue
    }
    const raw = attrs.pot_size
    if (raw === undefined || raw === null) continue
    // "25cm" / "25 厘米" / "25" 都能读出来；读不出就不搬，别把原值弄丢
    const num = Number(String(raw).replace(/[^\d.]/g, ''))
    if (!Number.isFinite(num) || num <= 0) continue
    if (attrs.pot_size_cm === undefined) attrs.pot_size_cm = Math.round(num)
    /*
     * 旧的 pot_size 键**故意留着**。
     *
     * 旧字段是归档不是删除 —— 用户在模板页能把它恢复。要是这里把值抹掉，
     * 恢复之后就是个空字段，那是数据丢失。
     * 活动模板用的是 pot_size_cm，所以这个残留键既不会出现在表单上，也不会被导出。
     */
    db.run('UPDATE plants SET attributes_json = ? WHERE id = ?', JSON.stringify(attrs), row.id)
  }

  // 2) 归档旧字段定义，界面上不再出现
  db.run("UPDATE field_definitions SET archived_at = datetime('now') WHERE id = ?", oldDef.id)
}

/**
 * 养护规则的两项表达能力。
 *
 * `once_per_window`：跨月区间里只做一次。原来「10~11 月」会生成两条任务，
 * 但底肥一季只需要埋一次，用户只能把区间收窄到单月来近似 ——
 * 那不是表达，是绕过。
 *
 * `recipe_id`：规则可以直接引用配方。底肥的「羊粪 + 缓释肥 + 少量骨粉」
 * 原来只能写成正文，材料比例是散的文字。
 */
const V8_RULE_FREQUENCY_AND_RECIPE = /* sql */ `
ALTER TABLE care_rules ADD COLUMN once_per_window INTEGER NOT NULL DEFAULT 0;
ALTER TABLE care_rules ADD COLUMN recipe_id INTEGER REFERENCES recipes(id);
`

/**
 * 任务要记得自己是从哪条规则来的。
 *
 * 原来 care_tasks 和 care_plans 都没有 rule_id —— 任务生成出来就和规则脱钩了，
 * 于是「这条规则绑了哪个配方」在任务卡片上根本查不到，
 * 而做任务的时候恰恰最需要看到材料清单。
 *
 * recipe_id 冗余存一份（规则上也有）：规则改了配方之后，
 * 已经生成的任务仍应显示当时的配方 —— 提醒的是那次要做的事。
 */
const V9_TASK_RULE_AND_RECIPE = /* sql */ `
ALTER TABLE care_tasks ADD COLUMN rule_id INTEGER;
ALTER TABLE care_tasks ADD COLUMN recipe_id INTEGER;
`

/**
 * 完成后记录当时用的是哪个配方。
 *
 * 任务卡片已经显示了配方，但那是「打算怎么做」；日志记的是「实际怎么做的」。
 * 过一年回头看「这盆当时埋的什么」，只有日志能回答。
 *
 * 存的是配方 id 而不是名字的副本：配方改了名字，历史记录的仍是同一份配方。
 */
const V10_LOG_RECIPE = /* sql */ `
ALTER TABLE care_logs ADD COLUMN recipe_id INTEGER;
`

/**
 * 养护位置加「区 / 县」一级。
 *
 * 起因是用户的真实需求：他的一株在**湘阴县**（岳阳下辖）。而 Open-Meteo
 * 的地理编码认不出湘阴县（华容县却认得出 —— 不是不支持，是不可靠）。
 * 和风天气的 GeoAPI 有完整的中国区县库，所以加这一级配合它用。
 *
 * 注意：**只有配了和风 key 时这一级才起作用**。没配 key 走 Open-Meteo 时，
 * 它只用于记录，坐标仍然落在市一级 —— 界面上要如实说明，不能假装更准了。
 */
const V11_ENV_DISTRICT = /* sql */ `
ALTER TABLE environments ADD COLUMN district TEXT;
`

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: V1_INIT },
  { version: 2, name: 'relation_fields', sql: V2_RELATION_FIELDS },
  { version: 3, name: 'month_sets', run: migrateMonthRangesToSets },
  { version: 4, name: 'care_cycle', sql: V4_CARE_CYCLE },
  { version: 5, name: 'phenology', sql: V5_PHASES },
  { version: 6, name: 'multi_species', sql: V6_MULTI_SPECIES },
  { version: 7, name: 'field_visibility', run: migrateFieldVisibility },
  { version: 8, name: 'rule_frequency_recipe', sql: V8_RULE_FREQUENCY_AND_RECIPE },
  { version: 9, name: 'task_rule_recipe', sql: V9_TASK_RULE_AND_RECIPE },
  { version: 10, name: 'log_recipe', sql: V10_LOG_RECIPE },
  { version: 11, name: 'env_district', sql: V11_ENV_DISTRICT }
]

/** 加列 + 搬盆径的值。两件事合在一个迁移里，因为它们属于同一次结构变更。 */
function migrateFieldVisibility(db: Db): void {
  db.exec(V7_FIELD_VISIBILITY)
  migratePotSize(db)
}

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
