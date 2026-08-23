import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import * as schema from '../db/schema';

export interface GoogleProfile {
  googleId: string;
  email: string;
  displayName?: string;
}

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: any) {}

  async findOrCreateFromGoogle(profile: GoogleProfile) {
    const existing = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.googleId, profile.googleId))
      .limit(1);

    if (existing.length > 0) {
      return existing[0];
    }

    const [created] = await this.db
      .insert(schema.users)
      .values({
        googleId: profile.googleId,
        email: profile.email,
        displayName: profile.displayName,
      })
      .returning();

    return created;
  }

  async findById(id: number) {
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);
    return user;
  }
}
