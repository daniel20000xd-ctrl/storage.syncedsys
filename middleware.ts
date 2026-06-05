import { NextResponse, type NextRequest } from 'next/server'

export function middleware(_req: NextRequest) {
  const res = NextResponse.next()
  for (const key of res.headers.keys()) {
    if (key.startsWith('cf-')) res.headers.delete(key)
  }
  return res
}

export const config = { matcher: '/api/:path*' }
