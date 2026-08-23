ALTER TABLE "word_attempts" ADD COLUMN "audio_data" "bytea";--> statement-breakpoint
ALTER TABLE "word_attempts" ADD COLUMN "flagged_incorrect" boolean DEFAULT false NOT NULL;