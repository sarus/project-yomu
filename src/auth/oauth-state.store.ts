import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE_NAME = 'yomu_oauth_state';
const MAX_AGE_SECONDS = 600; // generous — covers a slow Google login (password + 2FA)

export interface RequestWithOAuthReply extends FastifyRequest {
  _oauthReply?: FastifyReply;
}

function buildSetCookieHeader(value: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/auth/google',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}

/**
 * A passport-oauth2 "state store" (see the `store` constructor option) that
 * round-trips the CSRF nonce through a short-lived, HttpOnly cookie instead
 * of a server-side session.
 *
 * This app has no session middleware — it's a stateless JWT API — and the
 * kickoff route's `GoogleAuthGuard` hands Passport the *raw* Node response
 * (see `google-auth.guard.ts`) so `passport-oauth2`'s redirect can call
 * `res.setHeader`/`res.end()` directly. That bypasses Fastify's normal
 * response pipeline entirely, which means a session-plugin-based state
 * store (relying on Fastify's `onSend` hook to serialize `req.session` into
 * a `Set-Cookie` header) never actually gets to set its cookie — confirmed
 * empirically, the state param was generated but no Set-Cookie ever went
 * out. This store sidesteps that by writing the cookie header directly onto
 * the raw response itself, before Passport's redirect call.
 */
export class OAuthStateCookieStore {
  store(
    req: RequestWithOAuthReply,
    callback: (err: Error | null, state?: string) => void,
  ) {
    const reply = req._oauthReply;
    if (!reply) {
      return callback(new Error('OAuthStateCookieStore: no reply attached to request'));
    }
    const state = randomBytes(24).toString('hex');
    reply.raw.setHeader(
      'Set-Cookie',
      buildSetCookieHeader(state, MAX_AGE_SECONDS, req.protocol === 'https'),
    );
    callback(null, state);
  }

  verify(
    req: FastifyRequest,
    providedState: string,
    callback: (err: Error | null, ok?: boolean, info?: { message: string }) => void,
  ) {
    const cookieState = readCookie(req.headers.cookie);
    if (!cookieState || cookieState !== providedState) {
      return callback(null, false, { message: 'Invalid or missing OAuth state.' });
    }
    callback(null, true);
  }
}
