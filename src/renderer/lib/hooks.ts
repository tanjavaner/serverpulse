import { useEffect, useState } from 'react'

/** Göreli zaman metinleri için periyodik olarak güncellenen "şimdi". */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** Async veri yükleme; deps değişince ve her `refreshMs`'de bir yeniden çalışır. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], refreshMs?: number): { data: T | undefined; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    fn()
      .then((d) => alive && setData(d))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false))
    const t = refreshMs ? setTimeout(() => setTick((x) => x + 1), refreshMs) : undefined
    return () => {
      alive = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, loading, reload: () => setTick((x) => x + 1) }
}
