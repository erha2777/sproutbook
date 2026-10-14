/**
 * 生成演示数据：`node scripts/seed-demo.mjs [目标用户目录]`
 *
 * 会在目标目录下创建 data/sproutbook.db 并写入一组示例物种与植株。
 * 配合 Electron 的 --user-data-dir 使用，可以在不污染真实数据的前提下预览界面：
 *
 *   node scripts/seed-demo.mjs .cache/demo
 *   electron . --user-data-dir=.cache/demo
 *
 * 数据库非空时会直接跳过，不会覆盖你已有的数据。
 */

import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compileAndLoad, projectRoot } from './lib/compile.mjs'

const target = resolve(process.argv[2] ?? join(projectRoot, '.cache', 'demo'))
const dataDir = join(target, 'data')
mkdirSync(dataDir, { recursive: true })

const { require: load } = compileAndLoad(
  ['src/main/demo.ts', 'src/main/db/migrate.ts', 'src/main/db/seed.ts'],
  { label: '演示数据编译' }
)

const { Db } = load(join('main', 'db', 'connection.js'))
const { migrate } = load(join('main', 'db', 'migrate.js'))
const { seedAll } = load(join('main', 'db', 'seed.js'))
const { seedDemoData } = load(join('main', 'demo.js'))

const dbFile = join(dataDir, 'sproutbook.db')
const db = new Db(dbFile)

const report = migrate(db)
if (!report.ok) {
  console.error('迁移失败：', report.error)
  process.exit(1)
}

const seeded = seedAll(db)
const demo = seedDemoData(db)

console.log(`数据库：${dbFile}`)
console.log(`模板字段：新增 ${seeded.fields} 个，环境档案：新增 ${seeded.environments} 个`)
if (demo.species === 0) {
  console.log('数据库已有物种数据，跳过演示数据写入。')
} else {
  console.log(`演示数据：${demo.species} 个物种，${demo.plants} 株植物`)
}
db.close()
