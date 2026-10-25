/**
 * 「本月规则提醒」：规则库只做提示，不生成任务。
 *
 * 今日页和养护计划页都要显示同一份东西，所以抽成一个组件 —— 两处各写一遍，
 * 早晚会因为筛选条件不一致而报出不一样的数量。
 *
 * 数据：按当前月份 + 物种匹配筛规则；同标题的合并，显示适用株数。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { CareRule } from '@core/types'
import { ruleCoversMonth, ruleMatchesSpecies, todayIso } from '@core/care'
import { Panel, SectionTitle } from './ui'

export interface RuleReminderPlant {
  nickname: string
  speciesName: string | null
}

export function RuleReminders({
  plants,
  compact = false
}: {
  plants: RuleReminderPlant[]
  /** 紧凑模式：只显示「标题 · N 株」一行 chips，详情放 tooltip（养护计划页用） */
  compact?: boolean
}): ReactNode {
  const [rules, setRules] = useState<CareRule[]>([])

  useEffect(() => {
    void window.api.care
      .rules()
      .then(setRules)
      .catch(() => undefined)
  }, [])

  const rows = useMemo(() => {
    const month = Number(todayIso().slice(5, 7))
    const byTitle = new Map<string, { rule: CareRule; plants: string[] }>()
    for (const rule of rules) {
      if (!ruleCoversMonth(rule, month)) continue
      for (const plant of plants) {
        if (!ruleMatchesSpecies(rule.speciesKeys, plant.speciesName)) continue
        const hit = byTitle.get(rule.title) ?? { rule, plants: [] as string[] }
        hit.plants.push(plant.nickname)
        byTitle.set(rule.title, hit)
      }
    }
    return [...byTitle.values()].sort((a, b) => b.plants.length - a.plants.length)
  }, [rules, plants])

  if (rows.length === 0) return null

  if (compact) {
    return (
      <Panel flat>
        <div className="cal-guide-row" style={{ margin: 0 }}>
          <span className="small muted">本月规则提醒（{rows.length}）：</span>
          {rows.map(({ rule, plants: names }) => (
            <span
              key={rule.title}
              className="cal-guide-chip"
              title={`${rule.title} · ${names.length} 株${names.length <= 6 ? `（${names.join('、')}）` : ''}${
                rule.detail ? `\n${rule.detail}` : ''
              }`}
            >
              {rule.title} · {names.length} 株
            </span>
          ))}
          <span className="small muted">（规则只提示，不生成任务）</span>
        </div>
      </Panel>
    )
  }

  return (
    <Panel flat>
      <SectionTitle right={<span className="small muted">规则库只做提醒，不会自动加入计划</span>}>
        本月规则提醒（{rows.length}）
      </SectionTitle>
      {rows.map(({ rule, plants: names }) => (
        <div key={rule.title} className="rule-reminder">
          <span className="rule-reminder-title">{rule.title}</span>
          <span className="small muted">
            {' '}
            · {names.length} 株
            {names.length <= 3 ? `（${names.join('、')}）` : ''}
          </span>
          {rule.detail ? <div className="small muted">{rule.detail}</div> : null}
        </div>
      ))}
    </Panel>
  )
}
