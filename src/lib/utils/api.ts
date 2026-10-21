import { NextResponse } from 'next/server'

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'BUDGET_EXCEEDED'
  | 'INTERNAL_ERROR'

const STATUS_MAP: Record<ApiErrorCode, number> = {
  UNAUTHORIZED:    401,
  FORBIDDEN:       403,
  NOT_FOUND:       404,
  BAD_REQUEST:     400,
  CONFLICT:        409,
  RATE_LIMITED:    429,
  BUDGET_EXCEEDED: 402,
  INTERNAL_ERROR:  500,
}

export function apiError(code: ApiErrorCode, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { error: message, code, ...extra },
    { status: STATUS_MAP[code] }
  )
}

export function apiOk<T>(data: T, status = 200) {
  return NextResponse.json(data, { status })
}

/**
 * Validates required fields in a parsed JSON body.
 * Returns null if valid, or an error response if not.
 */
export function requireFields<T extends Record<string, unknown>>(
  body: T,
  fields: (keyof T)[]
): NextResponse | null {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      return apiError('BAD_REQUEST', `Missing required field: ${String(field)}`)
    }
  }
  return null
}

/**
 * Safe JSON body parser — returns [body, null] or [null, errorResponse]
 */
export async function parseBody<T = Record<string, unknown>>(
  req: Request
): Promise<[T, null] | [null, NextResponse]> {
  try {
    const body = await req.json() as T
    return [body, null]
  } catch {
    return [null, apiError('BAD_REQUEST', 'Invalid JSON body')]
  }
}
