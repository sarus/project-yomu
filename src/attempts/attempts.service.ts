import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, desc, and, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import * as schema from '../db/schema';
import { ASR_PROVIDER } from '../asr/asr.module';
import type { SpeechAssessmentProvider } from '../asr/asr.types';

@Injectable()
export class AttemptsService {
  constructor(
    @Inject(DB) private readonly db: any,
    @Inject(ASR_PROVIDER) private readonly asr: SpeechAssessmentProvider,
  ) {}

  async submitAttempt(
    userId: number,
    word: string,
    gradeLevel: string | undefined,
    audio: Buffer,
    pipeline: string,
    comparisonGroupId?: string,
  ) {
    const result = await this.asr.assessWord(audio, word);

    const [saved] = await this.db
      .insert(schema.wordAttempts)
      .values({
        userId,
        word,
        gradeLevel,
        correct: result.correct,
        accuracyScore: result.accuracyScore,
        recognizedText: result.recognizedText,
        phonemeBreakdown: result.phonemeBreakdown ?? null,
        provider: result.provider,
        rawProviderResponse: result.rawProviderResponse,
        audioData: audio,
        pipeline,
        comparisonGroupId: comparisonGroupId ?? null,
      })
      .returning();

    // Return the normalized result to the client — not the raw provider
    // response, which stays in the DB purely for later auditing/comparison.
    return {
      id: saved.id,
      word: saved.word,
      correct: saved.correct,
      accuracyScore: saved.accuracyScore,
      recognizedText: saved.recognizedText,
      phonemeBreakdown: saved.phonemeBreakdown,
      pipeline: saved.pipeline,
      comparisonGroupId: saved.comparisonGroupId,
    };
  }

  // Clears every attempt for every user — the audit page is already a
  // cross-user, any-authenticated-user view, so this matches that scope.
  async clearAll() {
    const deleted = await this.db
      .delete(schema.wordAttempts)
      .returning({ id: schema.wordAttempts.id });
    return { deletedCount: deleted.length };
  }

  async flagIncorrect(userId: number, attemptId: number) {
    const [updated] = await this.db
      .update(schema.wordAttempts)
      .set({ flaggedIncorrect: true })
      .where(and(eq(schema.wordAttempts.id, attemptId), eq(schema.wordAttempts.userId, userId)))
      .returning();

    if (!updated) {
      throw new NotFoundException('Attempt not found');
    }

    return { id: updated.id, flaggedIncorrect: updated.flaggedIncorrect };
  }

  // Cross-user audit view — no userId scoping, per the "any authenticated
  // user" access decision (no admin/role concept exists in this test app).
  async getAudit(page: number, pageSize: number, flaggedOnly: boolean) {
    const whereClause = flaggedOnly ? eq(schema.wordAttempts.flaggedIncorrect, true) : undefined;

    const [attempts, [{ count }]] = await Promise.all([
      this.db
        .select({
          id: schema.wordAttempts.id,
          word: schema.wordAttempts.word,
          gradeLevel: schema.wordAttempts.gradeLevel,
          correct: schema.wordAttempts.correct,
          accuracyScore: schema.wordAttempts.accuracyScore,
          recognizedText: schema.wordAttempts.recognizedText,
          flaggedIncorrect: schema.wordAttempts.flaggedIncorrect,
          pipeline: schema.wordAttempts.pipeline,
          comparisonGroupId: schema.wordAttempts.comparisonGroupId,
          rawProviderResponse: schema.wordAttempts.rawProviderResponse,
          createdAt: schema.wordAttempts.createdAt,
          userEmail: schema.users.email,
          userDisplayName: schema.users.displayName,
        })
        .from(schema.wordAttempts)
        .innerJoin(schema.users, eq(schema.wordAttempts.userId, schema.users.id))
        .where(whereClause)
        .orderBy(desc(schema.wordAttempts.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.wordAttempts)
        .where(whereClause),
    ]);

    return { page, pageSize, total: count, attempts };
  }

  async getAudio(attemptId: number): Promise<Buffer> {
    const [attempt] = await this.db
      .select({ audioData: schema.wordAttempts.audioData })
      .from(schema.wordAttempts)
      .where(eq(schema.wordAttempts.id, attemptId))
      .limit(1);

    if (!attempt?.audioData) {
      throw new NotFoundException('Audio not found for this attempt');
    }
    return attempt.audioData;
  }

  async getHistory(userId: number, limit = 50) {
    return this.db
      .select({
        id: schema.wordAttempts.id,
        word: schema.wordAttempts.word,
        correct: schema.wordAttempts.correct,
        accuracyScore: schema.wordAttempts.accuracyScore,
        createdAt: schema.wordAttempts.createdAt,
      })
      .from(schema.wordAttempts)
      .where(eq(schema.wordAttempts.userId, userId))
      .orderBy(desc(schema.wordAttempts.createdAt))
      .limit(limit);
  }

  async getSummary(userId: number) {
    const attempts = await this.db
      .select({
        word: schema.wordAttempts.word,
        correct: schema.wordAttempts.correct,
      })
      .from(schema.wordAttempts)
      .where(eq(schema.wordAttempts.userId, userId));

    const totalAttempts = attempts.length;
    const totalCorrect = attempts.filter((a: any) => a.correct).length;

    // Basic mastery signal: a word counts "mastered" once read correctly at
    // least twice — enough for a test build, refine into a real spaced
    // repetition model later.
    const correctCounts = new Map<string, number>();
    for (const a of attempts) {
      if (a.correct) {
        correctCounts.set(a.word, (correctCounts.get(a.word) ?? 0) + 1);
      }
    }
    const masteredWords = [...correctCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([word]) => word);

    return {
      totalAttempts,
      totalCorrect,
      accuracy: totalAttempts > 0 ? totalCorrect / totalAttempts : 0,
      masteredWords,
    };
  }
}
