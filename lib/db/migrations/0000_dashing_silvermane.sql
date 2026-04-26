CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_key" text NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_slug" text NOT NULL,
	"event_id" text,
	"external_id" text NOT NULL,
	"slug" text NOT NULL,
	"question" text NOT NULL,
	"description" text,
	"category" text,
	"outcomes" jsonb NOT NULL,
	"source_url" text NOT NULL,
	"ends_at" timestamp with time zone,
	"closed" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"market_id" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"prices" jsonb NOT NULL,
	"volume" double precision,
	"liquidity" double precision,
	"open_interest" double precision,
	CONSTRAINT "price_snapshots_market_id_taken_at_pk" PRIMARY KEY("market_id","taken_at")
);
--> statement-breakpoint
CREATE TABLE "snapshot_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "snapshot_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"homepage" text NOT NULL,
	"affiliate_url_template" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_venue_slug_venues_slug_fk" FOREIGN KEY ("venue_slug") REFERENCES "public"."venues"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_canonical_key_idx" ON "events" USING btree ("canonical_key");--> statement-breakpoint
CREATE INDEX "events_ends_at_idx" ON "events" USING btree ("ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_venue_external_idx" ON "markets" USING btree ("venue_slug","external_id");--> statement-breakpoint
CREATE INDEX "markets_event_idx" ON "markets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "markets_last_seen_idx" ON "markets" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "markets_closed_idx" ON "markets" USING btree ("closed");--> statement-breakpoint
CREATE INDEX "snapshots_taken_at_idx" ON "price_snapshots" USING btree ("taken_at");