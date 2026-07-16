# Deploying oddz to Vercel

Two mechanisms exist; both are blocked only by ONE Vercel-side permission.

## The blocker (as of last attempt)
`deploy_to_vercel` (file upload) returns HTTP 403:
"You don't have permission to create a project."
The connected Vercel identity on team team_SHExwgJuZWO8si3H3Nwf7xho cannot
CREATE a new project. Deploying INTO an existing project is not blocked.

## Unblock (pick one — both are one-time)
1. In the Vercel dashboard, create an empty project named `oddz`
   (Add New -> Project -> skip git import / "Deploy" a blank one, or
   create via `Other` framework). Then re-run the deploy — it targets the
   existing `oddz` project instead of creating, which the identity CAN do.
2. OR re-authorize the Vercel connector in claude.ai with write/create
   scope, or grant the team member project-creation permission
   (https://vercel.com/docs/accounts/team-members-and-roles).

## Deploy mechanism A — tiny bootstrap (preferred, no 186KB inline)
Upload 3 files (package.json, vercel.json, scripts/vercel-bootstrap-build.sh
as vercel-build.sh at root). The build clones this repo's branch, injects
DB_POOLED + CRON_SECRET into next.config.ts env, migrates, builds, seeds.
projectSettings: framework=nextjs, buildCommand="bash vercel-build.sh".
Requires the repo be clonable by Vercel's build (public, or Vercel git
integration provides the token).

## Deploy mechanism B — full file upload
Run scripts/build-deploy-payload.mjs (env DATABASE_URL_DIRECT/POOLED,
CRON_SECRET) -> /tmp/deploy-files.json, pass its array as deploy_to_vercel
`files`. 75 files / ~186KB. No repo-clone dependency.

## After a successful deploy
- GET https://<url>/api/health  -> expect ok:true
- GET "https://<url>/api/cron/snapshot?key=<CRON_SECRET>" once to seed data
- Check /status shows a run; cron (vercel.json) runs every 5 min

## UPDATE: file-upload path is NOT viable from chat
Confirmed: routing the ~150KB (73-file) source, or even a ~52KB gzip+base64
blob, through deploy_to_vercel's inline `files` arg is not reliable — the
assistant's file-read truncates at ~22KB and base64 has zero error
tolerance, so exact bytes can't be moved by hand. Autonomous deploy needs
the source to reach Vercel WITHOUT inlining. Two workable paths:

1. GIT-CONNECT (cleanest, permanent): in the oddz project → Settings → Git,
   connect aerozsz/oddz + branch claude/refactor-project-structure-JIiXS.
   Vercel pulls directly, handles private-repo auth, auto-deploys on push.
   Set env vars DATABASE_URL (pooled) + CRON_SECRET in the same settings.
   The repo's committed package.json vercel-build (migrate && next build &&
   seed) + vercel.json cron (Bearer, auto-signed when CRON_SECRET is set)
   then just work.
2. TEMP-PUBLIC (assistant does it autonomously): flip the repo public
   briefly; the tested 3-file clone bootstrap (scripts/vercel-bootstrap-build.sh)
   deploys via mcp deploy_to_vercel; flip back to private. Brief exposure.
