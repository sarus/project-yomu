import {
  pgTable,
  serial,
  integer,
  text,
  varchar,
  boolean,
  real,
  jsonb,
  timestamp,
  customType,
} from 'drizzle-orm/pg-core';

// No built-in Drizzle helper for bytea — postgres.js (our driver) reads/writes
// it as a plain Node Buffer, so that's the type on both sides here.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  googleId: varchar('google_id', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const wordAttempts = pgTable('word_attempts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  word: varchar('word', { length: 100 }).notNull(),
  gradeLevel: varchar('grade_level', { length: 20 }),

  // Normalized result — same shape regardless of which ASR provider produced it
  correct: boolean('correct').notNull(),
  accuracyScore: real('accuracy_score'), // 0-100 — pronunciation accuracy, not ASR transcription confidence
  recognizedText: text('recognized_text'),
  phonemeBreakdown: jsonb('phoneme_breakdown'), // array of { phoneme, accuracyScore } | null

  // Provenance — which provider produced this, and its raw response for later comparison
  provider: varchar('provider', { length: 50 }).notNull(),
  rawProviderResponse: jsonb('raw_provider_response'),

  // Which client-side audio pipeline produced the submitted audio — lets us
  // A/B noise-suppression approaches. 'unspecified' backfills rows written
  // before this column existed, when no pipeline was tracked at all.
  pipeline: varchar('pipeline', { length: 20 }).notNull().default('unspecified'),
  // Shared by the 2 rows produced from one "compare both pipelines" recording
  // (same spoken word, submitted twice) — null for a normal single-pipeline attempt.
  comparisonGroupId: varchar('comparison_group_id', { length: 36 }),

  // Raw submitted audio (WAV) and a user-facing "Azure got this wrong" flag —
  // testing-phase-only fields for building a dataset to tune CORRECT_THRESHOLD.
  // bytea is fine for now at this data volume; revisit with object storage if it grows.
  audioData: bytea('audio_data'),
  flaggedIncorrect: boolean('flagged_incorrect').notNull().default(false),

  createdAt: timestamp('created_at').defaultNow().notNull(),
});
