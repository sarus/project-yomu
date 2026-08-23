import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UsersService } from '../users/users.service';
import { GoogleAuthGuard } from './google-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  // Kicks off the Google OAuth flow — the guard handles the redirect to Google.
  @Get('google')
  @UseGuards(GoogleAuthGuard)
  googleLogin() {
    // Intentionally empty — Passport intercepts before this body runs.
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(
    @Req() req: FastifyRequest & { user: any },
    @Res() res: FastifyReply,
  ) {
    const user = await this.users.findOrCreateFromGoogle(req.user);
    const token = this.jwt.sign({ sub: user.id, email: user.email });

    // For this test build, just redirect to the client with the token as
    // a query param — swap for an httpOnly cookie once this graduates
    // past a throwaway test app.
    const clientUrl = this.config.get<string>('CLIENT_URL', 'http://localhost:3000');
    // Nest pre-applies the route's default 200 status to the reply before this
    // handler runs, so Fastify's redirect() needs an explicit code or it reuses
    // that 200 instead of defaulting to 302.
    res.redirect(`${clientUrl}/auth/callback?token=${token}`, 302);
  }
}
