ALTER TABLE "word_attempts" ADD COLUMN "pipeline" varchar(20) DEFAULT 'unspecified' NOT NULL;--> statement-breakpoint
ALTER TABLE "word_attempts" ADD COLUMN "comparison_group_id" varchar(36);