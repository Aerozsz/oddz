CREATE TABLE "geo_monitor_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "geo_monitor_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"relevant" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"notified" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"source_slug" text NOT NULL,
	"source_label" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"summary" text,
	"side" text NOT NULL,
	"theater" text NOT NULL,
	"intensity" text NOT NULL,
	"market_lean" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "geo_signals_first_seen_idx" ON "geo_signals" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "geo_signals_side_idx" ON "geo_signals" USING btree ("side");--> statement-breakpoint
CREATE INDEX "geo_signals_theater_idx" ON "geo_signals" USING btree ("theater");