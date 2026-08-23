import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { FastifyReply } from 'fastify';
import type { RequestWithOAuthReply } from './oauth-state.store';

// passport-oauth2's redirect-based flow calls res.setHeader/res.end directly,
// which Fastify's reply wrapper doesn't expose — hand it the raw Node response instead.
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  getResponse(context: ExecutionContext) {
    return context.switchToHttp().getResponse<FastifyReply>().raw;
  }

  canActivate(context: ExecutionContext) {
    // OAuthStateCookieStore needs the FastifyReply (not just its raw response,
    // which is all getResponse() above hands to Passport) to set the CSRF
    // state cookie during the kickoff redirect — stash it on the request.
    const request = context.switchToHttp().getRequest<RequestWithOAuthReply>();
    request._oauthReply = context.switchToHttp().getResponse<FastifyReply>();
    return super.canActivate(context);
  }
}
