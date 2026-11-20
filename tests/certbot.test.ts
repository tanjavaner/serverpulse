import { describe, expect, it } from 'vitest'
import { t, type MsgKey } from '../src/shared/i18n'
import { certbotHints, parseCertbotCertificates, unitHints } from '../src/main/parsers/certbot'

const fixture = `Saving debug log to /var/log/letsencrypt/letsencrypt.log

- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
Found the following certs:
  Certificate Name: example.com
    Serial Number: 030abc
    Key Type: ECDSA
    Domains: example.com www.example.com
    Expiry Date: 2026-12-01 10:00:00+00:00 (VALID: 10 days)
    Certificate Path: /etc/letsencrypt/live/example.com/fullchain.pem
    Private Key Path: /etc/letsencrypt/live/example.com/privkey.pem
  Certificate Name: old.example.net-0001
    Serial Number: 03def
    Key Type: RSA
    Domains: old.example.net
    Expiry Date: 2026-10-01 09:02:01+00:00 (INVALID: EXPIRED)
    Certificate Path: /etc/letsencrypt/live/old.example.net-0001/fullchain.pem
  Certificate Name: tomorrow.example.org
    Domains: tomorrow.example.org
    Expiry Date: 2026-11-21 10:00:00+00:00 (VALID: 1 day)
`

describe('parseCertbotCertificates', () => {
  it('parses multiple certificates, domains, expiry strings and expired certificates', () => {
    expect(parseCertbotCertificates(fixture)).toEqual([
      { name: 'example.com', domains: ['example.com', 'www.example.com'], daysLeft: 10, expiry: '2026-12-01 10:00:00+00:00' },
      { name: 'old.example.net-0001', domains: ['old.example.net'], daysLeft: 0, expiry: '2026-10-01 09:02:01+00:00' },
      { name: 'tomorrow.example.org', domains: ['tomorrow.example.org'], daysLeft: 1, expiry: '2026-11-21 10:00:00+00:00' }
    ])
    expect(parseCertbotCertificates(fixture.replace(/\n/g, '\r\n'))).toHaveLength(3)
  })

  it('handles empty, denied, incomplete and unknown validity output', () => {
    expect(parseCertbotCertificates('')).toEqual([])
    expect(parseCertbotCertificates('sudo: a password is required')).toEqual([])
    expect(parseCertbotCertificates('Certificate Name: incomplete\nDomains: a.test b.test')).toEqual([
      { name: 'incomplete', domains: ['a.test', 'b.test'], daysLeft: null }
    ])
    expect(parseCertbotCertificates('Certificate Name: invalid\nExpiry Date: 2026-11-21 10:00:00+00:00 (INVALID: TEST_CERT)')[0].daysLeft).toBeNull()
  })
})

const title = (key: string): string => t(`unit.hint.${key}.title` as MsgKey)

describe('certbotHints', () => {
  it.each([
    ['Could not bind TCP port 80 because it is already in use by another process. Address already in use', 'portConflict'],
    ['Timeout during connect (likely firewall problem)', 'portUnreachable'],
    ['Connection refused', 'portUnreachable'],
    ['Fetching http://example.com/.well-known/acme-challenge/token: Timeout', 'portUnreachable'],
    ['DNS problem: NXDOMAIN looking up A for old.example.net', 'dns'],
    ['urn:ietf:params:acme:error:rateLimited: too many certificates already issued', 'rateLimit'],
    ['too many failed authorizations recently', 'rateLimit'],
    ['unauthorized: Invalid response from http://example.com/.well-known/acme-challenge/token: 404', 'challenge'],
    ['No renewals were attempted. Certificate not yet due for renewal', 'notDue'],
    ['sudo: a password is required. Permission denied', 'permission']
  ])('recognizes %s and deduplicates its hint', (text, key) => {
    const hints = certbotHints(`${text}\n${text.toUpperCase()}`)
    expect(hints).toHaveLength(1)
    expect(hints[0].title).toBe(title(key))
    expect(hints[0].detail).toBeTruthy()
  })

  it('returns several distinct hints for independent errors and none for normal output', () => {
    expect(certbotHints('NXDOMAIN\nConnection refused\nsudo: a password is required').map((h) => h.title)).toEqual([
      title('portUnreachable'), title('dns'), title('permission')
    ])
    expect(certbotHints('Congratulations, all renewals succeeded')).toEqual([])
  })

  it('generic unit hints only recognize permissions', () => {
    expect(unitHints('Permission denied\nsudo: a password is required')).toHaveLength(1)
    expect(unitHints('Address already in use\nNXDOMAIN\nnot yet due')).toEqual([])
    expect(unitHints('')).toEqual([])
  })
})
