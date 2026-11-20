import { t, type MsgKey } from '@shared/i18n'
import type { UnitDiagnosis } from '@shared/types'

export function parseCertbotCertificates(out: string): NonNullable<UnitDiagnosis['certs']> {
  const certs: NonNullable<UnitDiagnosis['certs']> = []
  let current: NonNullable<UnitDiagnosis['certs']>[number] | undefined
  for (const line of out.split(/\r?\n/)) {
    const name = /^\s*Certificate Name:\s*(.+?)\s*$/.exec(line)
    if (name) {
      current = { name: name[1], domains: [], daysLeft: null }
      certs.push(current)
      continue
    }
    if (!current) continue
    const domains = /^\s*Domains:\s*(.*?)\s*$/.exec(line)
    if (domains) current.domains = domains[1].split(/\s+/).filter(Boolean)
    const expiry = /^\s*Expiry Date:\s*(.+?)\s*\(([^)]+)\)/.exec(line)
    if (expiry) {
      current.expiry = expiry[1]
      const valid = /^VALID:\s*(\d+)\s+days?\b/i.exec(expiry[2])
      current.daysLeft = valid ? Number(valid[1]) : /EXPIRED/i.test(expiry[2]) ? 0 : null
    }
  }
  return certs
}

type HintRule = { pattern: RegExp; key: string }
const permission: HintRule = { pattern: /Permission denied|sudo: a password is required/i, key: 'permission' }
const certbotRules: HintRule[] = [
  { pattern: /Address already in use|Could not bind/i, key: 'portConflict' },
  { pattern: /Timeout during connect|Connection refused|Fetching http/i, key: 'portUnreachable' },
  { pattern: /NXDOMAIN|DNS problem/i, key: 'dns' },
  { pattern: /too many certificates|rateLimited|too many failed authorizations/i, key: 'rateLimit' },
  { pattern: /unauthorized|Invalid response from/i, key: 'challenge' },
  { pattern: /No renewals were attempted|not yet due/i, key: 'notDue' },
  permission
]

function hints(text: string, rules: HintRule[]): UnitDiagnosis['hints'] {
  return rules.filter((rule) => rule.pattern.test(text)).map(({ key }) => ({
    title: t(`unit.hint.${key}.title` as MsgKey),
    detail: t(`unit.hint.${key}.detail` as MsgKey)
  }))
}

export function certbotHints(text: string): UnitDiagnosis['hints'] {
  return hints(text, certbotRules)
}

export function unitHints(text: string): UnitDiagnosis['hints'] {
  return hints(text, [permission])
}
