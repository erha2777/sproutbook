// Electron 运行时能力自检：确认 node:sqlite 可用、WAL 可开、绑定行为符合预期。
// 用法：$env:ELECTRON_RUN_AS_NODE='1'; .\node_modules\electron\dist\electron.exe scripts/runtime-probe.cjs
const out = []
const log = (...a) => out.push(a.join(' '))

log('electron:', process.versions.electron ?? '(run-as-node)')
log('node:', process.versions.node)
log('chrome:', process.versions.chrome ?? '-')

let sqlite
try {
  sqlite = require('node:sqlite')
  log('node:sqlite: AVAILABLE')
} catch (e) {
  log('node:sqlite: MISSING ->', e.message)
  console.log(out.join('\n'))
  process.exit(1)
}

const db = new sqlite.DatabaseSync(':memory:')
log('sqlite_version:', db.prepare('select sqlite_version() as v').get().v)

db.exec('PRAGMA journal_mode = WAL;')
db.exec('PRAGMA foreign_keys = ON;')

db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, flag INTEGER, score REAL)')
const ins = db.prepare('INSERT INTO t (name, flag, score) VALUES (?, ?, ?)')
const r = ins.run('月季', 1, 3.5)
log('insert ->', JSON.stringify({ changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }))

// 关键坑位验证：boolean / undefined 能否直接绑定
for (const [label, value] of [['boolean true', true], ['boolean false', false], ['undefined', undefined]]) {
  try {
    ins.run(label, value, 1)
    log(`bind ${label}: ACCEPTED`)
  } catch (e) {
    log(`bind ${label}: REJECTED -> ${e.constructor.name}`)
  }
}

// 命名参数行为验证
try {
  const named = db.prepare('SELECT $a AS a')
  log('named bare param:', JSON.stringify(named.get({ a: 7 })))
} catch (e) {
  log('named bare param: FAILED ->', e.message)
}

// 事务与回滚
db.exec('BEGIN')
ins.run('rolled-back', 0, 0)
db.exec('ROLLBACK')
log('after rollback count:', db.prepare('SELECT COUNT(*) c FROM t').get().c)

// WITHOUT ROWID + 复合主键 upsert（attr_index 用到的语法）
db.exec('CREATE TABLE ai (k TEXT, i INTEGER, v TEXT, PRIMARY KEY (k, i)) WITHOUT ROWID')
db.prepare('INSERT INTO ai VALUES (?,?,?) ON CONFLICT(k,i) DO UPDATE SET v=excluded.v').run('a', 0, 'first')
db.prepare('INSERT INTO ai VALUES (?,?,?) ON CONFLICT(k,i) DO UPDATE SET v=excluded.v').run('a', 0, 'second')
log('upsert result:', db.prepare('SELECT v FROM ai WHERE k=? AND i=?').get('a', 0).v)

log('total rows:', db.prepare('SELECT COUNT(*) c FROM t').get().c)
console.log(out.join('\n'))
