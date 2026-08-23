CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"google_id" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
CREATE TABLE "word_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"word" varchar(100) NOT NULL,
	"grade_level" varchar(20),
	"correct" boolean NOT NULL,
	"confidence" real,
	"recognized_text" text,
	"phoneme_breakdown" jsonb,
	"provider" varchar(50) NOT NULL,
	"raw_provider_response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "word_attempts" ADD CONSTRAINT "word_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;