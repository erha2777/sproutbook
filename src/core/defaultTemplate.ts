/**
 * 默认信息模板 —— 首次启动时写入 field_definitions。
 *
 * 与你原始需求的对照（关键改动都注明了理由）：
 *
 *  | 你的字段       | 本模板实现                                              | 为什么 |
 *  |----------------|--------------------------------------------------------|--------|
 *  | 植物名称       | common_name（系统列，锁定的必填）                       | 列表/搜索/排序都要用，放独立列而不是 JSON |
 *  | 别名           | aliases（标签，多值）                                   | 别名通常有多个 |
 *  | 图片           | cover_image（图片类型）                                 | 走 images 表，不塞进 JSON |
 *  | 开花时期       | bloom_months（月份区间）                                | 「春季」无法被日历和统计使用 |
 *  | 是否需要春化   | needs_vernalization（是否）                             | — |
 *  | 寿命           | lifespan（单选）                                        | — |
 *  | 花期           | bloom_duration（数字·天）                               | 与「开花时期」区分：一个是什么时候开，一个是开多久 |
 *  | 香味           | fragrance（单选）                                       | — |
 *  | 所属科         | family（系统列）                                        | 统计与分组要按科聚合 |
 *  | 毒             | 拆成 4 个安全字段（等级/部位/症状/急救）                 | 「有毒」两个字既不能筛选也不能指导急救 |
 *  | 耐热           | heat_tolerance（数字·最高耐受 ℃）                        | 可参与极端高温预警 |
 *  | 耐寒           | cold_hardiness（数字·最低耐受 ℃）                        | 可参与霜冻预警，这是它最大的价值 |
 *  | 生长环境       | light_requirement（多选）                               | 很多植物既能全日照也能半阴 |
 *  | 光照时长       | light_hours（数值区间·小时）                             | 与环境档案里的实际光照做匹配度计算 |
 *  | 其他益处/害处  | benefits / drawbacks                                    | — |
 */

import type { NewFieldDefinition } from './types'
import { CULTIVATION_OPTIONS, FLOWER_COLOR_OPTIONS } from './sprite'

type Seed = Omit<NewFieldDefinition, 'ownerKind'>

const speciesFields: Seed[] = [
  // ---- 基础 ----
  {
    key: 'common_name',
    label: '植物名称',
    groupName: '基础',
    type: 'text',
    isRequired: true,
    helpText: '最常用的中文名。系统字段，不可删除。'
  },
  {
    key: 'scientific_name',
    label: '学名',
    groupName: '基础',
    type: 'text',
    helpText: '拉丁学名，如 Rosa chinensis。用于和各种资料对齐。'
  },
  {
    key: 'aliases',
    label: '别名',
    groupName: '基础',
    type: 'tags',
    helpText: '用逗号分隔多个别名。'
  },
  {
    key: 'family',
    label: '所属科',
    groupName: '基础',
    type: 'text',
    helpText: '如 蔷薇科。统计页会按科聚合，建议统一写法。'
  },
  {
    key: 'genus',
    label: '所属属',
    groupName: '基础',
    type: 'text'
  },

  // ---- 形态 ----
  {
    key: 'growth_habit',
    label: '株型',
    groupName: '形态',
    type: 'select',
    options: ['草本', '灌木', '乔木', '藤本', '多肉', '球根', '水生', '蕨类', '附生'],
    helpText: '决定将来「花园视图」用哪套生长阶段素材。'
  },
  {
    key: 'mature_height',
    label: '成株高度',
    groupName: '形态',
    type: 'number',
    unit: 'cm'
  },
  {
    key: 'lifespan',
    label: '寿命',
    groupName: '形态',
    type: 'select',
    options: ['一年生', '二年生', '多年生', '短命多年生']
  },

  // ---- 习性 ----
  {
    key: 'bloom_months',
    label: '开花时期',
    groupName: '习性',
    type: 'month_range',
    helpText: '可以选多段。一年开两次的（如月季 4~6 月 + 9~11 月）就把两段都点上；跨年也可以，如 11 月~次年 2 月。'
  },
  {
    key: 'bloom_duration',
    label: '花期',
    groupName: '习性',
    type: 'number',
    unit: '天',
    helpText: '单朵或单次开花持续多少天。'
  },
  {
    key: 'flower_color',
    label: '花色',
    groupName: '形态',
    type: 'select',
    // 用中文色名而不是让人填十六进制：养花的人说「粉色」，不会说「#e86a8a」
    options: [...FLOWER_COLOR_OPTIONS],
    helpText: '决定花园视图里画成什么颜色。留空则按物种名取一个固定颜色。'
  },
  {
    key: 'needs_vernalization',
    label: '是否需要春化',
    groupName: '习性',
    type: 'bool',
    helpText: '需要低温春化的植物，冬季不能搬进暖气房。'
  },
  {
    key: 'fragrance',
    label: '香味',
    groupName: '习性',
    type: 'select',
    options: ['无香', '淡香', '浓香', '异味']
  },
  {
    key: 'light_requirement',
    label: '生长环境',
    groupName: '习性',
    type: 'multiselect',
    options: ['全日照', '半阴', '全阴', '明亮散射光'],
    helpText: '可多选。与环境档案的实际光照做匹配度提示。'
  },
  {
    key: 'light_hours',
    label: '光照时长',
    groupName: '习性',
    type: 'hours_range',
    unit: '小时',
    helpText: '每日直射光照需求，如 6 ~ 8。'
  },
  {
    key: 'heat_tolerance',
    label: '耐热',
    groupName: '习性',
    type: 'number',
    unit: '℃',
    helpText: '可耐受的最高温度。用于极端高温预警。'
  },
  {
    key: 'cold_hardiness',
    label: '耐寒',
    groupName: '习性',
    type: 'number',
    unit: '℃',
    helpText: '可耐受的最低温度（负数）。用于霜冻预警。'
  },
  {
    key: 'dormancy_months',
    label: '休眠期',
    groupName: '习性',
    type: 'month_range',
    helpText: '同样可以选多段：夏天和冬天各休眠一次的植物（如某些多肉、球根）就点上两段。'
  },
  {
    key: 'water_need',
    label: '需水量',
    groupName: '习性',
    type: 'select',
    options: ['少', '中等', '多', '干透浇透']
  },

  // ---- 安全（全部标记为 isSafety：AI 填充后必须人工确认）----
  {
    key: 'toxicity_level',
    label: '毒性等级',
    groupName: '安全',
    type: 'select',
    options: ['无毒', '微毒', '有毒', '剧毒', '未知'],
    isSafety: true,
    helpText: '安全字段：AI 填充后必须人工核实，应用不会自动确认。'
  },
  {
    key: 'toxic_parts',
    label: '有毒部位',
    groupName: '安全',
    type: 'multiselect',
    // 无毒的时候问「哪个部位有毒」是自相矛盾
    visibleWhen: { key: 'toxicity_level', in: ['微毒', '有毒', '剧毒'] },
    options: ['叶', '花', '果实', '种子', '根', '茎', '汁液', '全株'],
    isSafety: true
  },
  {
    key: 'toxic_symptoms',
    visibleWhen: { key: 'toxicity_level', in: ['微毒', '有毒', '剧毒'] },
    label: '中毒症状',
    groupName: '安全',
    type: 'longtext',
    isSafety: true
  },
  {
    key: 'first_aid',
    visibleWhen: { key: 'toxicity_level', in: ['微毒', '有毒', '剧毒'] },
    label: '急救处理',
    groupName: '安全',
    type: 'longtext',
    isSafety: true
  },
  {
    key: 'pet_safe',
    label: '对宠物安全',
    groupName: '安全',
    type: 'bool',
    isSafety: true
  },

  // ---- 其他 ----
  { key: 'benefits', label: '其他益处', groupName: '其他', type: 'longtext' },
  { key: 'drawbacks', label: '其他害处', groupName: '其他', type: 'longtext' },
  { key: 'care_notes', label: '养护要点', groupName: '其他', type: 'longtext' },
  { key: 'notes', label: '备注', groupName: '其他', type: 'longtext' }
]

/**
 * 植株信息模板。
 *
 * 这里刻意把「所属物种 / 养护位置 / 状态」也做成模板字段（以前它们硬编码在表单里）。
 * 理由：它们和「昵称」「入手日期」一样都是**列支撑的系统字段**，
 * 只让一部分进模板、另一部分写死，用户就没法统一调整位置、标签和分组 ——
 * 那与「字段是数据不是代码」的设计自相矛盾。
 */
const plantFields: Seed[] = [
  { key: 'nickname', label: '昵称', groupName: '基础', type: 'text', isRequired: true, helpText: '例如「阳台那盆月季」。' },
  {
    key: 'species_id',
    label: '所属物种',
    groupName: '基础',
    type: 'relation',
    relationTarget: 'species',
    helpText: '物种信息在物种库统一维护，多株同类可共用。'
  },
  {
    key: 'env_id',
    label: '养护位置',
    groupName: '基础',
    type: 'relation',
    relationTarget: 'environments',
    helpText: '位置档案决定了光照匹配与霜冻预警。可在「设置 → 养护位置」里维护。'
  },
  {
    key: 'status',
    label: '状态',
    groupName: '基础',
    type: 'select',
    // 选项是存储值（英文键）；显示名由渲染层映射，见 lib/util.ts 的 PLANT_STATUS_LABELS
    options: ['growing', 'dormant', 'sick', 'dead', 'gifted'],
    helpText: '决定花园里那一株显示成什么样子。'
  },
  { key: 'acquired_at', label: '入手 / 播种日期', groupName: '基础', type: 'date', helpText: '生长进度与养护计划的时间基准。' },
  {
    key: 'cultivation',
    label: '栽种方式',
    groupName: '基础',
    type: 'select',
    // 怎么种是**植株**的属性，不是物种的：同一株薄荷，你可以种盆里也可以种地里
    options: [...CULTIVATION_OPTIONS],
    helpText: '决定花园视图里画成什么底座。留空则水生植物默认水培、其余默认盆栽。'
  },
  {
    key: 'pot_size_cm',
    label: '盆径',
    groupName: '基础',
    type: 'number',
    unit: 'cm',
    // 地栽的没有盆，水培的也没有 —— 无条件问「盆径多少」是噪音
    visibleWhen: { key: 'cultivation', in: ['盆栽'] },
    helpText: '量一下盆口直径。决定花园视图里花盆画多大。'
  },
  {
    key: 'actual_height_cm',
    label: '现状高度',
    groupName: '基础',
    type: 'number',
    unit: 'cm',
    helpText: '你自己量的：从土面到最高处。填了就以它为准，比推算准得多。'
  },
  {
    key: 'age_years',
    label: '苗龄',
    groupName: '基础',
    type: 'number',
    unit: '年',
    helpText:
      '这株养了几年。没量现状高度时按它推算大小 —— 只对木本（乔木 / 灌木 / 藤本）有用，草本和多肉一季就长满，年龄不说明大小。'
  },
  { key: 'plant_notes', label: '备注', groupName: '其他', type: 'longtext' }
]

/**
 * 系统字段 → 数据库列的映射。
 * 这些字段在模板里可见、可改标签、可排序，但**不可删除**，
 * 且值存放于独立列（便于建索引、做搜索与聚合），不写进 attributes_json。
 */
export const SYSTEM_COLUMNS: Record<string, string> = {
  common_name: 'common_name',
  scientific_name: 'scientific_name',
  family: 'family',
  genus: 'genus',
  aliases: 'aliases_json',
  nickname: 'nickname',
  species_id: 'species_id',
  env_id: 'env_id',
  status: 'status',
  acquired_at: 'acquired_at'
}

export function defaultFieldDefinitions(): NewFieldDefinition[] {
  return [
    ...speciesFields.map((f) => ({ ...f, ownerKind: 'species' as const })),
    ...plantFields.map((f) => ({ ...f, ownerKind: 'plant' as const }))
  ]
}
