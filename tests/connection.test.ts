import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Client } from 'ssh2'
import { agentSocket, ExecTimeoutError, execOn, isAuthError } from '../src/main/ssh/connection'
import { setHttp } from '../src/main/collectors'
import type { ServerState } from '../src/shared/types'

/** exec çağrısında verilen parçaları sırayla yayan sahte ssh2 client'ı. */
function fakeClient(chunks: Buffer[], opts: { close?: boolean } = {}): Client {
  return {
    exec(_cmd: string, cb: (err: Error | undefined, stream: EventEmitter & { stderr: EventEmitter; close: () => void }) => void) {
      const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: () => undefined })
      cb(undefined, stream)
      setImmediate(() => {
        for (const c of chunks) stream.emit('data', c)
        if (opts.close !== false) stream.emit('close', 0)
      })
    }
  } as unknown as Client
}

describe('execOn', () => {
  it('çok baytlı UTF-8 karakter parça sınırında bölünse de bozulmaz', async () => {
    const text = 'Güncelleme başarılı: ığüşöç'
    const buf = Buffer.from(text, 'utf8')
    // "ü" (2 bayt) ortasından böl
    const cut = buf.indexOf(Buffer.from('ü', 'utf8')) + 1
    const r = await execOn(fakeClient([buf.subarray(0, cut), buf.subarray(cut)]), 'x', 1000)
    expect(r.stdout).toBe(text)
    expect(r.code).toBe(0)
  })

  it('zaman aşımında ExecTimeoutError fırlatır', async () => {
    await expect(execOn(fakeClient([], { close: false }), 'x', 20)).rejects.toBeInstanceOf(ExecTimeoutError)
  })
})

describe('kimlik doğrulama hatası tespiti', () => {
  it('ssh2 client-authentication seviyesini tanır', () => {
    expect(isAuthError(Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }))).toBe(true)
    expect(isAuthError(Object.assign(new Error('connect ECONNREFUSED'), { level: 'client-socket' }))).toBe(false)
    expect(isAuthError(null)).toBe(false)
  })
})

describe('HTTP ardışık hata sayacı', () => {
  it('hatada artar, başarıda sıfırlanır', () => {
    const st = { http: {} } as unknown as ServerState
    const fail = { ok: false, status: 502, ms: 10, error: 'HTTP 502' }
    setHttp(st, 'h1', fail)
    setHttp(st, 'h1', fail)
    expect(st.http.h1.failures).toBe(2)
    setHttp(st, 'h1', { ok: true, status: 200, ms: 10 })
    expect(st.http.h1.failures).toBe(0)
  })
})

describe('ssh-agent soketi', () => {
  it('Windows: OpenSSH named pipe ya da Pageant; diğerleri: SSH_AUTH_SOCK', () => {
    // Gerçek yol: \\.\pipe\openssh-ssh-agent (String.raw ile ters bölüler kaçışsız yazılır)
    expect(agentSocket('openssh', 'win32', {})).toBe(String.raw`\\.\pipe\openssh-ssh-agent`)
    expect(agentSocket(undefined, 'win32', {})).toBe(String.raw`\\.\pipe\openssh-ssh-agent`)
    expect(agentSocket('pageant', 'win32', {})).toBe('pageant')
    expect(agentSocket('openssh', 'darwin', { SSH_AUTH_SOCK: '/tmp/agent.sock' })).toBe('/tmp/agent.sock')
    expect(agentSocket('openssh', 'darwin', {})).toBeUndefined()
  })
})
