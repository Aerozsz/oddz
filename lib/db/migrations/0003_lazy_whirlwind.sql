CREATE TABLE "alert_rules" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alert_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"watcher_id" text NOT NULL,
	"market_id" text NOT NULL,
	"kind" text NOT NULL,
	"threshold" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triggered_at" timestamp with time zone,
	"triggered_value" double precision
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_rules_watcher_idx" ON "alert_rules" USING btree ("watcher_id");--> statement-breakpoint
CREATE INDEX "alert_rules_market_idx" ON "alert_rules" USING btree ("market_id");