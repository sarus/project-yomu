import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DB = Symbol('DB');

// Global so any feature module can just @Inject(DB) without re-importing DbModule everywhere.
@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Neon-friendly: small pool, since this connects through Neon's pooled endpoint.
        const client = postgres(config.getOrThrow<string>('DATABASE_URL'), {
          max: 5,
        });
        return drizzle(client, { schema });
      },
    },
  ],
  exports: [DB],
})
export class DbModule {}
