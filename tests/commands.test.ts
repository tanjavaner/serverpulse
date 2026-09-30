import { describe, expect, it } from 'vitest'
import { CMD, buildScript, parseSections, safeName, UnsafeInputError } from '../src/main/ssh/commands'

describe('komut whitelist doğrulaması', () => {
  it('geçerli adları kabul eder', () => {
    for (const n of ['backend-api-1', 'sesli_asistan', 'node_exporter', 'a.b-c_d']) expect(safeName(n)).toBe(n)
  })

  it('shell enjeksiyonu içeren adları reddeder', () => {
    for (const n of ['a;rm -rf /', 'x$(id)', 'a b', '`id`', 'a|b', "a'b", 'a\nb', '', 'x'.repeat(200)]) {
      expect(() => safeName(n)).toThrow(UnsafeInputError)
    }
  })

  it('komut üreticileri doğrulanmamış girdiyi kabul etmez', () => {
    expect(() => CMD.postgres('pg; id', 'postgres')).toThrow()
    expect(() => CMD.systemd(['nginx', 'x && reboot'])).toThrow()
    expect(() => CMD.containerLogs('$(whoami)')).toThrow()
    expect(() => CMD.httpLocal([{ host: '127.0.0.1', port: 80, path: "/a'; id; '" }], 5)).toThrow()
    expect(() => CMD.httpLocal([{ host: '127.0.0.1;id', port: 80 }], 5)).toThrow()
    expect(() => CMD.httpLocal([{ host: '127.0.0.1', port: 70000 }], 5)).toThrow()
  })

  it('log komutları sınırlıdır ve asla takip modunda değildir', () => {
    const c = CMD.containerLogs('grafana')
    const u = CMD.unitLogs('nginx')
    expect(c).toContain('--tail 200')
    expect(u).toContain('-n 200')
    for (const cmd of [c, u]) expect(cmd).not.toMatch(/\s(-f|--follow|-F)\b/)
  })

  it('asterisk komutları sudoers kuralıyla birebir eşleşir', () => {
    const s = CMD.asterisk(false).map((x) => x.cmd)
    expect(s).toEqual([
      "sudo -n /usr/sbin/asterisk -rx 'core show channels count'",
      "sudo -n /usr/sbin/asterisk -rx 'pjsip show registrations'",
      "sudo -n /usr/sbin/asterisk -rx 'pjsip show endpoints'"
    ])
    expect(CMD.asterisk(true)[0].cmd).not.toContain('sudo')
  })
})

describe('bölümlü betik', () => {
  it('işaretleyicilerle çıktıyı ayırır ve çıkış kodlarını okur', () => {
    const script = buildScript([
      { name: 'a', cmd: 'echo 1' },
      { name: 'b', cmd: 'false' }
    ])
    expect(script).toContain("echo '@@S a'")
    const out = '@@S a\n1\n@@RC 0\n@@S b\n@@RC 1\n'
    const s = parseSections(out)
    expect(s.a).toEqual({ out: '1', rc: 0 })
    expect(s.b).toEqual({ out: '', rc: 1 })
  })

  it('satır sonu olmadan biten çıktıda (curl -w) işaretleyici yapışsa da bölümler ayrılır', () => {
    // Gerçek VDS'te görülen durum: curl -w çıktısı "\n" ile bitmez
    const out = '@@S h0\n200 0.001234@@RC 0\n@@S h1\n000 0.000100@@RC 7\n@@S h2\n404 0.002@@RC 0\n'
    const s = parseSections(out)
    expect(s.h0).toEqual({ out: '200 0.001234', rc: 0 })
    expect(s.h1).toEqual({ out: '000 0.000100', rc: 7 })
    expect(s.h2).toEqual({ out: '404 0.002', rc: 0 })
  })

  it('yarım kalan bölümü rc=null ile döndürür', () => {
    expect(parseSections('@@S a\nfoo\nbar').a).toEqual({ out: 'foo\nbar', rc: null })
  })

  it('geçersiz bölüm adını reddeder', () => {
    expect(() => buildScript([{ name: "x'; id", cmd: 'true' }])).toThrow()
  })
})
