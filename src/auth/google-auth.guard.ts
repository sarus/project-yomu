import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { FastifyReply } from 'fastify';

// passport-oauth2's redirect-based flow calls res.setHeader/res.end directly,
// which Fastify's reply wrapper doesn't expose — hand it the raw Node response instead.
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  getResponse(context: ExecutionContext) {
    return context.switchToHttp().getResponse<FastifyReply>().raw;
  }
}
