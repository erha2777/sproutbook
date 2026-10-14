/**
 * 尚未实现的模块占位页。
 * 明确列出「计划做什么」和「数据结构是否已就绪」，避免给人「点了没反应」的感觉。
 */

import type { ReactNode } from 'react'
import { Button, EmptyState, Notice, Panel, SectionTitle } from '../components/ui'

export interface ComingSoonProps {
  icon: string
  title: string
  description: string
  /** 数据库结构是否已经就绪（表已建好，只差界面） */
  schemaReady?: boolean
  bullets: string[]
  onGoGarden: () => void
}

export function ComingSoonPage({ icon, title, description, schemaReady, bullets, onGoGarden }: ComingSoonProps): ReactNode {
  return (
    <div className="content-inner">
      <Panel>
        <EmptyState
          icon={icon}
          title={`${title}（开发中）`}
          hint={description}
          action={<Button onClick={onGoGarden}>先去管理我的植物</Button>}
        />
      </Panel>

      <Panel>
        <SectionTitle>这个模块计划做什么</SectionTitle>
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
          {bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        {schemaReady ? (
          <div style={{ marginTop: 12 }}>
            <Notice tone="info">
              数据库表结构已经建好（<span className="mono">recipes / recipe_items / care_plans / care_tasks / care_rules</span>），
              后续版本只需要补界面，不会动到你已录入的数据。
            </Notice>
          </div>
        ) : null}
      </Panel>
    </div>
  )
}
