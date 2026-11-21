# Deployment

## Provision Supabase

1. Create a Supabase project and enable email/password authentication under Authentication providers.
2. Apply the migrations under `supabase/migrations` in filename order. Link and update a CLI-managed project with these commands.

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

3. Set your deployment URL in the Supabase Auth URL configuration. If email confirmation is enabled, configure the auth redirect URLs and SMTP settings appropriate for your project.
4. Gather the project URL, anon key, and service-role key. Enter the service-role key only in the server secret environment. Review [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Configure Vercel

1. Import the application directory or a Git repository containing it. Select Next.js with a Node.js runtime.
2. Populate the environment variables from `.env.example`. Set `APP_BASE_URL` to the canonical HTTPS origin and `DEMO_MODE=false` for an authenticated live-only deployment.
3. Configure `OPENAI_API_KEY`, `OPENAI_MODEL`, and the corresponding pricing fields for live research.
4. Deploy the application. Check `/api/health`, sign in, and exercise a scan with a small ticker list before enabling automatic scans.

Hosted demo persistence requires the Supabase project URL, publishable or anon key, service-role key, and an independently generated `DEMO_SESSION_SECRET` of at least 32 characters. For hosted environments other than Vercel, set `DEMO_STORAGE=supabase` to enable the remote demo store. Local demo persistence uses `.data` by default. Set `OPTIONS_DATA_DIR` to override that location.

## Schedule jobs

Create a high-entropy `CRON_SECRET` and configure an authenticated scheduler to call `/api/cron`. The scheduler sends the secret as a bearer token. The app uses New York market time for user schedules and evaluates applicable operating days. Work is advanced in bounded units. Choose a cadence that allows a multi-ticker scan to finish within your expected time window and respects plan limits. Vercel Cron evaluates its invocation expressions in UTC. See [Vercel Cron](https://vercel.com/docs/cron-jobs).

Generate independent random values for `CRON_SECRET` and `DEMO_SESSION_SECRET` when both are used. Run `openssl rand -hex 32` once per value.

Test the authenticated HTTPS request with curl.

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_BASE_URL/api/cron"
```

Keep scheduler credentials in its secret manager. Monitor job errors, scan completion, database health, and the discrepancy between estimated usage and actual billed cost.

## Local production build

```bash
npm ci
npm run build
npm run start
```
