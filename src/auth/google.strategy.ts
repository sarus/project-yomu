import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy, VerifyCallback, Profile } from 'passport-google-oauth20';
import { OAuthStateCookieStore } from './oauth-state.store';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: config.getOrThrow<string>('GOOGLE_CALLBACK_URL'),
      scope: ['email', 'profile'],
      // Generates and verifies a per-request nonce, carried in a short-lived
      // cookie (see oauth-state.store.ts) so the callback can't be replayed
      // against a different browser — see security.md, "OAuth login had
      // no CSRF (state) protection".
      store: new OAuthStateCookieStore(),
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ) {
    const { id, emails, displayName } = profile;
    const user = {
      googleId: id,
      email: emails?.[0]?.value ?? '',
      displayName,
    };
    done(null, user);
  }
}
