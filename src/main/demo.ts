/**
 * 演示数据：一组有代表性的物种与植株，用于快速体验 / 截图 / 联调。
 *
 * 覆盖了各种字段类型（月份区间、多选、布尔、数字、安全字段），
 * 因此也能当作「模板系统是否工作正常」的直观检查。
 */

import type { Db } from './db/connection'
import { saveSpecies } from './db/repo/species'
import { savePlant } from './db/repo/plants'
import { listEnvironments } from './db/repo/misc'

interface DemosSpecies {
  values: Record<string, unknown>
  plants: Array<{ nickname: string; status?: string; acquiredAt?: string; potSize?: string; notes?: string }>
}

const DEMO_SPECIES: DemosSpecies[] = [
  {
    values: {
      common_name: '月季',
      scientific_name: 'Rosa chinensis',
      family: '蔷薇科',
      genus: '蔷薇属',
      aliases: ['月月红', '斗雪红', '四季花'],
      growth_habit: '灌木',
      mature_height: 120,
      lifespan: '多年生',
      bloom_months: [4, 5, 6, 9, 10, 11], // 主花期 + 秋季复花，盛夏歇息
      bloom_duration: 7,
      needs_vernalization: false,
      fragrance: '浓香',
      light_requirement: ['全日照'],
      light_hours: { min: 6, max: 8 },
      heat_tolerance: 38,
      cold_hardiness: -15,
      dormancy_months: [12, 1, 2],
      water_need: '中等',
      toxicity_level: '无毒',
      pet_safe: true,
      benefits: '花期长、花色丰富，是阳台盆栽的主力花卉。花瓣可食用，可做花茶与玫瑰酱。',
      drawbacks: '病虫多（黑斑病、红蜘蛛、蚜虫），需要定期修剪与打药，养护强度较高。',
      care_notes: '喜光，每天至少 6 小时直射光。花后及时剪去残花促进复花。冬季重剪并清园。'
    },
    plants: [
      { nickname: '阳台那盆红月季', acquiredAt: '2023-03-18', potSize: '32cm', notes: '2024 年春天换过一次盆。' },
      { nickname: '窗台的小月季', status: 'sick', acquiredAt: '2024-05-02', potSize: '20cm', notes: '最近叶片有黑斑，正在处理。' }
    ]
  },
  {
    values: {
      common_name: '绿萝',
      scientific_name: 'Epipremnum aureum',
      family: '天南星科',
      genus: '麒麟叶属',
      aliases: ['黄金葛', '魔鬼藤'],
      growth_habit: '藤本',
      lifespan: '多年生',
      needs_vernalization: false,
      fragrance: '无香',
      light_requirement: ['半阴', '全阴', '明亮散射光'],
      light_hours: { min: 2, max: 5 },
      heat_tolerance: 35,
      cold_hardiness: 8,
      water_need: '中等',
      toxicity_level: '有毒',
      toxic_parts: ['叶', '茎', '汁液'],
      toxic_symptoms: '误食后口腔与咽喉灼痛、流涎、恶心呕吐。汁液接触皮肤可能引起红肿瘙痒。',
      first_aid: '误食后立即漱口并饮用少量清水，不要催吐，尽快就医。皮肤接触用大量清水冲洗。',
      pet_safe: false,
      benefits: '耐阴、好养，能吸收甲醛等挥发性有机物，适合室内绿化。',
      care_notes: '忌强光直射，冬季注意保温不低于 10℃。浇水见干见湿，避免积水烂根。'
    },
    plants: [{ nickname: '客厅绿萝', acquiredAt: '2022-09-10', potSize: '18cm' }]
  },
  {
    values: {
      common_name: '绣球',
      scientific_name: 'Hydrangea macrophylla',
      family: '绣球花科',
      genus: '绣球属',
      aliases: ['八仙花', '紫阳花'],
      growth_habit: '灌木',
      mature_height: 150,
      lifespan: '多年生',
      bloom_months: [5, 6, 7, 8],
      bloom_duration: 30,
      needs_vernalization: true,
      fragrance: '淡香',
      light_requirement: ['半阴'],
      light_hours: { min: 3, max: 5 },
      heat_tolerance: 32,
      cold_hardiness: -12,
      water_need: '多',
      toxicity_level: '有毒',
      toxic_parts: ['叶', '花', '茎'],
      toxic_symptoms: '含有氰苷，大量误食会引起恶心、呕吐、腹泻。',
      first_aid: '少量误食可饮水观察；出现明显症状请立即就医。',
      pet_safe: false,
      benefits: '花球硕大，花色随土壤 pH 变化（酸蓝碱红），观赏价值高。',
      drawbacks: '需水量大，夏天一天不浇就蔫；花后修剪时机不对会影响次年开花。',
      care_notes: '需低温春化，冬季不要放暖气房。大花绣球多在老枝开花，修剪要在花后 8 月前完成。'
    },
    plants: [{ nickname: '南阳台绣球', acquiredAt: '2023-04-20', potSize: '28cm', notes: '今年调蓝失败，还是粉的。' }]
  },
  {
    values: {
      common_name: '玉露',
      scientific_name: 'Haworthia cooperi',
      family: '阿福花科',
      genus: '瓦苇属',
      aliases: ['宝草'],
      growth_habit: '多肉',
      mature_height: 8,
      lifespan: '多年生',
      bloom_months: [4, 5, 6],
      needs_vernalization: false,
      fragrance: '无香',
      light_requirement: ['半阴', '明亮散射光'],
      light_hours: { min: 3, max: 5 },
      heat_tolerance: 30,
      cold_hardiness: 5,
      water_need: '少',
      dormancy_months: [7, 8], // 夏季休眠
      toxicity_level: '无毒',
      pet_safe: true,
      benefits: '株型小巧，叶片透亮如玉石，适合窗台小盆栽培。',
      care_notes: '忌强光暴晒，夏季高温休眠期要控水。浇水避免叶心积水。'
    },
    plants: [{ nickname: '书桌玉露', acquiredAt: '2024-01-15', potSize: '8cm' }]
  },
  {
    values: {
      common_name: '迷迭香',
      scientific_name: 'Salvia rosmarinus',
      family: '唇形科',
      genus: '鼠尾草属',
      aliases: ['海洋之露'],
      growth_habit: '灌木',
      mature_height: 90,
      lifespan: '多年生',
      bloom_months: [3, 4, 5],
      bloom_duration: 20,
      fragrance: '浓香',
      light_requirement: ['全日照'],
      light_hours: { min: 6, max: 10 },
      heat_tolerance: 35,
      cold_hardiness: -8,
      water_need: '少',
      toxicity_level: '无毒',
      pet_safe: true,
      benefits: '香草，可摘取枝条用于烤肉与烘焙；耐旱，适合懒人。',
      drawbacks: '怕涝，盆土长期潮湿极易烂根；北方冬季需入室。',
      care_notes: '宁干勿湿，土表干透再浇。每年春季修剪三分之一，避免木质化后下部光秃。'
    },
    plants: [{ nickname: '厨房迷迭香', acquiredAt: '2023-11-05', potSize: '16cm' }]
  },
  {
    values: {
      common_name: '龟背竹',
      scientific_name: 'Monstera deliciosa',
      family: '天南星科',
      genus: '龟背竹属',
      aliases: ['蓬莱蕉', '电线兰'],
      growth_habit: '藤本',
      mature_height: 200,
      lifespan: '多年生',
      fragrance: '无香',
      light_requirement: ['半阴', '明亮散射光'],
      light_hours: { min: 3, max: 6 },
      heat_tolerance: 35,
      cold_hardiness: 10,
      water_need: '中等',
      toxicity_level: '有毒',
      toxic_parts: ['叶', '茎', '汁液'],
      toxic_symptoms: '含草酸钙针晶，误食引起口舌剧烈灼痛、肿胀、流涎。',
      first_aid: '立即用清水漱口，可饮用牛奶缓解，症状严重请就医。',
      pet_safe: false,
      benefits: '叶片开裂形态独特，耐阴，是室内大型绿植的首选。',
      care_notes: '喜明亮散射光，忌冷风直吹。空气干燥时叶缘易焦，可适当喷雾。'
    },
    plants: [{ nickname: '客厅龟背竹', acquiredAt: '2022-06-01', potSize: '35cm', notes: '已经长出第 9 片开背叶。' }]
  }
]

export interface DemoResult {
  species: number
  plants: number
}

/**
 * 写入演示数据。**只在数据库为空时执行**，避免污染已有数据。
 */
export function seedDemoData(db: Db): DemoResult {
  const existing = Number(db.scalar<number>('SELECT COUNT(*) AS c FROM species') ?? 0)
  if (existing > 0) return { species: 0, plants: 0 }

  const environments = listEnvironments(db)
  const envByName = new Map(environments.map((e) => [e.name, e.id]))

  let speciesCount = 0
  let plantCount = 0

  // 每个物种一个事务，失败不影响其它，便于定位问题数据
  for (const demo of DEMO_SPECIES) {
    const saved = saveSpecies(db, { values: demo.values, source: 'seed' }, 'import')
    if (Object.keys(saved.errors).length > 0 || saved.species.id === 0) continue
    speciesCount++

    demo.plants.forEach((p, index) => {
      const envName = index % 2 === 0 ? '南向阳台' : '露台'
      const envId = envByName.get(envName) ?? environments[0]?.id ?? null
      const result = savePlant(db, {
        speciesId: saved.species.id,
        envId,
        status: (p.status as never) ?? 'growing',
        nickname: p.nickname,
        notes: p.notes ?? null,
        values: {
          nickname: p.nickname,
          acquired_at: p.acquiredAt ?? null,
          pot_size: p.potSize ?? null
        }
      })
      if (result.plant) plantCount++
    })
  }

  return { species: speciesCount, plants: plantCount }
}
