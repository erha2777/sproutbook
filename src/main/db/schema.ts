/**
 * 数据库结构定义（迁移即历史，只增不改）。
 *
 * 规则：
 *  1. 已发布的迁移**永不修改**，需要变更就追加新版本。
 *  2. 所有时间字段用 TEXT 存 ISO 字符串（SQLite 没有原生日期类型）。
 *  3. 软删除优先：能归档就不物理删除，避免用户误操作丢数据。
 */

export interface Migration {
  version: number
  name: string
  sql: string
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

export const MIGRATIONS: Migration[] = [{ version: 1, name: 'init', sql: V1_INIT }]

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
