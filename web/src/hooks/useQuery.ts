import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'

/** GET a JSON path; re-fetches when `path` or `tick` changes and keeps the previous data meanwhile. */
export function useQuery<T>(path: string | null, tick: unknown = 0) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const last = useRef<string | null>(null)

  useEffect(() => {
    if (!path) return
    let alive = true
    if (last.current !== path) setData(null) // a different resource: do not show the old one
    last.current = path
    setLoading(true)
    api<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.code : String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [path, tick])

  return { data, error, loading }
}
