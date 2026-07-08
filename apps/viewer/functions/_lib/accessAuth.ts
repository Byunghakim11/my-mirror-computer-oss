/**
 * Cloudflare Access JWT verification (M3-01).
 *
 * Cloudflare Access sits in front of the app and, once the user has passed the
 * configured login policy (WebAuthn per ADR-016), forwards the request with a
 * signed JWT in the `Cf-Access-Jwt-Assertion` header (and CF_Authorization
 * cookie). This module verifies that JWT against the team's public keys and
 * confirms issuer, audience, expiry, and the allowed account.
 *
 * The MFA method and auth freshness are enforced at the Access policy + session
 * duration layer (see ADR-016 / docs/15); this module verifies the signed
 * assertion. Verification is fail-closed: any problem returns null.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose'

type KeySet = Parameters<typeof jwtVerify>[1]

export interface AccessAuthConfig {
  /** https://<team>.cloudflareaccess.com */
  readonly issuer: string
  /** The Access application AUD tag. */
  readonly audience: string
  /**
   * Allowed account identifiers (emails and/or subjects). Empty means "rely on
   * the Access policy allowlist"; when set, the Worker additionally enforces it
   * as defense in depth.
   */
  readonly allowedSubjects: readonly string[]
}

export interface AccessIdentity {
  readonly subject: string
  readonly email: string
}

const ACCESS_CERTS_PATH = '/cdn-cgi/access/certs'
const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion'
const ACCESS_COOKIE_NAME = 'CF_Authorization'

/** Build the remote JWKS resolver for a team domain. Cache one per issuer so
 * jose reuses fetched keys across requests. */
export function createAccessKeySet(issuer: string): KeySet {
  return createRemoteJWKSet(new URL(ACCESS_CERTS_PATH, issuer))
}

/** Extract the Access assertion from the header, falling back to the cookie. */
export function readAccessToken(request: Request): string | null {
  const header = request.headers.get(ACCESS_JWT_HEADER)
  if (header) {
    return header
  }
  const cookie = request.headers.get('cookie')
  if (!cookie) {
    return null
  }
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) {
      continue
    }
    if (part.slice(0, separator).trim() === ACCESS_COOKIE_NAME) {
      return part.slice(separator + 1).trim() || null
    }
  }
  return null
}

/**
 * Verify a Cloudflare Access JWT. Returns the identity on success, or null when
 * the signature, issuer, audience, expiry, or account allowlist check fails.
 */
export async function verifyAccessJwt(
  token: string,
  config: AccessAuthConfig,
  keySet: KeySet,
): Promise<AccessIdentity | null> {
  let email = ''
  let subject = ''
  try {
    const { payload } = await jwtVerify(token, keySet, {
      audience: config.audience,
      issuer: config.issuer,
    })
    subject = typeof payload.sub === 'string' ? payload.sub : ''
    email = typeof payload.email === 'string' ? payload.email : ''
  } catch {
    return null
  }

  if (!subject) {
    return null
  }
  if (config.allowedSubjects.length > 0) {
    const identifiers = [email, subject].filter(Boolean)
    if (!identifiers.some((id) => config.allowedSubjects.includes(id))) {
      return null
    }
  }
  return { email, subject }
}
