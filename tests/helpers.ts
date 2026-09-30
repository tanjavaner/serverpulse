import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function fx(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8').replace(/\r\n/g, '\n')
}
