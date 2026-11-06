# Buzz and Bugs — Backend

REST API and background worker for **Buzz and Bugs**, a developer community platform.

The backend serves a website and native mobile clients from one API. It covers accounts and
sessions, profiles, posts (Buzz), replies, votes, follows, blocking, report-driven moderation with
appeals, warnings and bans, cached external news/events/trending content, notifications, user
settings, an admin API and persistent background jobs.

This document is local development documentation only. It deliberately contains no deployment
instructions.

---

## 1. Technology

| Area       | Choice                                                      |
| ---------- | ----------------------------------------------------------- |
| Runtime    | Node.js 20+ (developed on Node 22)                          |
| Language   | TypeScript (ESM, strict)                                    |
| HTTP       | Fastify 5                                                   |
| Validation | Zod, wired into Fastify through `fastify-type-provider-zod` |
| API docs   | `@fastify/swagger` + Swagger UI at `/docs`                  |
| Database   | PostgreSQL 14+ (developed on PostgreSQL 18)                 |
| ORM        | Prisma 6 with committed migrations                          |
| Jobs       | pg-boss 10 (PostgreSQL-backed queue)                        |
| Logging    | Pino (pretty output in development)                         |
| Email      | Nodemailer (SMTP, provider neutral)                         |
| Passwords  | Argon2id (`argon2`)                                         |
| Images     | `sharp` (EXIF strip + WebP re-encode)                       |
| Feeds      | `fast-xml-parser`                                           |
| Tests      | Vitest + Fastify injection                                  |

There are no paid services, no Redis, no Docker and no separate queue database.

---

## 2. What you need installed

1. **Node.js 20 or newer** — <https://nodejs.org> (LTS installer). Check with `node -v`.
2. **npm 10 or newer** — ships with Node. Check with `npm -v`.
3. **PostgreSQL 14 or newer** — <https://www.postgresql.org/download/windows/>.
   During installation, remember the password you set for the `postgres` superuser.
4. A terminal. On Windows 11, "Git Bash" or "PowerShell" both work. The commands below use
   `npm`, which behaves the same in either.

Optional, only for the features that need them:

- An OpenAI API key — required for content moderation on **edits** and for report triage.
- A YouTube Data API key — required for the YouTube trending section.
- A Gmail account with an App Password — required to send real email.

---

## 3. Create the local database

Open a terminal and connect as the PostgreSQL superuser (it will ask for the password you chose
during installation):

```bash
psql -U postgres -h localhost
```

Then run these three statements:

```sql
CREATE ROLE bnb LOGIN PASSWORD 'choose-a-local-password' CREATEDB;
CREATE DATABASE bnb OWNER bnb;
CREATE DATABASE bnb_test OWNER bnb;
```

`CREATEDB` is needed because Prisma creates a temporary "shadow database" while generating
migrations, and because the test suite needs its own database.

Type `\q` to exit `psql`.

If `psql` is not on your PATH, use the full path, for example:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost
```

### Why a separate `bnb_test` database?

The test suite **truncates every table** between tests. It refuses to run unless the database name
ends with `_test`, so your development data can never be wiped by a test run.

---

## 4. Configure `.env`

Copy the example file:

```bash
cp .env.example .env
```

(On PowerShell: `Copy-Item .env.example .env`.)

Open `.env` and set at least these values:

| Variable            | What to put                                                                 |
| ------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`      | `postgresql://bnb:choose-a-local-password@localhost:5432/bnb?schema=public` |
| `SESSION_SECRET`    | A random string of 32+ characters                                           |
| `EMAIL_HASH_SECRET` | A different random string of 32+ characters                                 |

Generate secrets quickly with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Run it twice and paste one value into each variable.

Everything else can stay at its default for local development. See section 10 for what each
variable does.

---

## 5. Install dependencies

```bash
npm install
```

If `sharp` reports `Could not load the "sharp" module`, install the optional platform binaries:

```bash
npm install --include=optional sharp
```

---

## 6. Generate Prisma Client and apply migrations

```bash
npm run prisma:generate
npm run prisma:deploy
```

`prisma:deploy` applies the migrations that are already committed in `prisma/migrations/`. This is
the command to use on any machine that should keep its existing data.

During development, after you change `prisma/schema.prisma`, create a new migration with:

```bash
npm run prisma:migrate -- --name describe_your_change
```

This generates SQL, applies it, and regenerates the client. **Never** run `prisma migrate reset`
or `prisma db push --force-reset` against a database that holds data you care about — they drop
the schema. `prisma db push` is also unsafe here because it skips migration history.

Check the state of migrations at any time:

```bash
npm run prisma:status
```

---

## 7. Create the admin account

The admin is a separate identity stored in its own table. It is not a user account and has no
email address.

```bash
npm run admin:create -- --username admin --password "a-long-admin-password"
```

Rules:

- The password must be at least 12 characters.
- Only one admin can exist. The command refuses to create a second one.
- If you omit `--password`, a random password is generated and printed **once**.

Change the admin password later (requires the old password, revokes all admin sessions):

```bash
npm run admin:password -- --old "current-password" --new "new-long-password"
```

There is intentionally **no HTTP route** for changing the admin password.

---

## 8. Start the API and the worker

The API and the worker are two processes running from the same codebase and the same database.
Start both, in two separate terminals.

Terminal 1 — API:

```bash
npm run dev
```

Terminal 2 — worker:

```bash
npm run dev:worker
```

Production-style run (after `npm run build`):

```bash
npm start          # API
npm run start:worker
```

The API listens on <http://localhost:4000>. Verify it:

```bash
curl http://localhost:4000/api/v1/health
```

A healthy response looks like:

```json
{
  "data": {
    "status": "ok",
    "api": { "status": "up" },
    "database": { "status": "up", "latencyMs": 2 },
    "worker": { "status": "up", "lastSeenSecondsAgo": 3 }
  }
}
```

`worker.status` is `down` until `npm run dev:worker` is running. That is expected.

### What the worker does

The worker owns every background task: refreshing news/events/trending caches, sending queued
email, running moderation triage, expiring appeals, purging deleted accounts, cleaning up
notifications and expired tokens, and writing its own heartbeat.

If the worker is not running:

- registration and password-reset codes still work (those emails are sent inline),
- welcome/moderation/notification emails queue up until the worker starts,
- reported posts are moderated inline as a fallback,
- external content never refreshes.

---

## 9. Run the tests

```bash
npm test
```

The suite needs `bnb_test` to exist. It applies migrations automatically, then truncates tables
between tests. It never touches the `bnb` database.

Useful variants:

```bash
npm run test:watch                 # re-run on change
npx vitest run tests/posts.test.ts # one file
```

Tests use mocked external services, a fake mail transport and no API keys, so they run offline.

---

## 10. Environment variables

| Variable                                                | Required | Purpose                                                                           |
| ------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `NODE_ENV`                                              | yes      | `development`, `test` or `production`. Controls cookie security and error detail. |
| `API_HOST` / `API_PORT`                                 | yes      | Where Fastify listens. Defaults `0.0.0.0` / `4000`.                               |
| `LOG_LEVEL`                                             | no       | Pino level. Default `info`.                                                       |
| `APP_BASE_URL`                                          | yes      | Public base URL used in emails, post URLs and media links.                        |
| `WEB_ORIGINS`                                           | yes      | Comma separated CORS/CSRF allowlist for browser clients.                          |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW`                  | no       | Global burst protection per IP. Default 300/minute.                               |
| `DATABASE_URL`                                          | yes      | PostgreSQL connection string.                                                     |
| `TEST_DATABASE_URL`                                     | no       | Overrides the derived test database URL.                                          |
| `SESSION_SECRET`                                        | yes      | 32+ chars. Keys CSRF tokens and keyed hashes.                                     |
| `EMAIL_HASH_SECRET`                                     | yes      | 32+ chars. Keys the hashed email used for ban-time registration blocks.           |
| `EMAIL_TRANSPORT`                                       | yes      | `smtp` to deliver, `json` to log instead of sending.                              |
| `SMTP_HOST`                                             | for SMTP | SMTP server, e.g. `smtp.gmail.com`.                                               |
| `SMTP_PORT`                                             | for SMTP | `587` for STARTTLS, `465` for SSL.                                                |
| `SMTP_SECURE_MODE`                                      | for SMTP | `starttls`, `ssl` or `none`.                                                      |
| `SMTP_USER`                                             | for SMTP | SMTP username (your Gmail address for Gmail).                                     |
| `SMTP_PASSWORD`                                         | for SMTP | SMTP password or Gmail **App Password**.                                          |
| `MAIL_FROM_ADDRESS` / `MAIL_FROM_NAME`                  | yes      | Sender identity. For Gmail this must match `SMTP_USER`.                           |
| `OPENAI_API_KEY`                                        | optional | Enables moderation triage and post-edit checks.                                   |
| `OPENAI_MODERATION_MODEL`                               | no       | Defaults to `omni-moderation-latest`.                                             |
| `YOUTUBE_API_KEY`                                       | optional | Enables the YouTube trending section.                                             |
| `LINK_PREVIEW_API_URL` / `LINK_PREVIEW_API_KEY`         | optional | Reserved for the link-preview provider.                                           |
| `STORAGE_DRIVER`                                        | yes      | Only `local` is implemented.                                                      |
| `STORAGE_DIR`                                           | yes      | Where avatars are written. Default `./var/uploads` (git-ignored).                 |
| `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` | optional | Read only by `npm run admin:create`.                                              |

The API refuses to start when a mandatory variable is missing or malformed, and prints exactly
which one is wrong.

### Using a real Gmail account for email

1. Enable 2-Step Verification on the Google account.
2. Create an **App Password** at <https://myaccount.google.com/apppasswords>.
3. Set:

```dotenv
EMAIL_TRANSPORT=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE_MODE=starttls
SMTP_USER=your.address@gmail.com
SMTP_PASSWORD=the-16-character-app-password
MAIL_FROM_ADDRESS=your.address@gmail.com
```

Never use your normal Google password, and never commit `.env`.

With `EMAIL_TRANSPORT=json` nothing is delivered; messages are written to the `EmailDelivery`
table with status `SIMULATED` and the worker logs that delivery was skipped. This is the default
so the project runs before you configure SMTP.

---

## 11. API documentation

- Swagger UI: <http://localhost:4000/docs>
- Raw OpenAPI 3.1 document: <http://localhost:4000/docs/json>

Every route lives under `/api/v1`. Authentication:

- **Website**: `bnb_session` HTTP-only cookie plus an `x-csrf-token` header for any
  `POST`/`PATCH`/`DELETE` request. The matching `bnb_csrf` cookie is set at login.
- **Mobile**: `Authorization: Bearer <session token>` returned in the `Set-Cookie` header value at
  login. Bearer requests do not need CSRF tokens.

### Route map

| Area             | Routes                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication   | `POST /auth/register/request-otp`, `/auth/register/verify-otp`, `/auth/register/complete`, `/auth/login`, `/auth/logout`, `/auth/password/change`, `/auth/password/reset/{request,verify,complete}`, `/auth/account-deletion/{request,confirm,cancel}` |
| Sessions         | `GET /auth/me`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `DELETE /auth/sessions`                                                                                                                                                             |
| Users            | `GET /users/:username`, `PATCH /users/me`, `POST /users/me/avatar`, `GET /users/:username/{posts,followers,following}`, `POST                                                                                                                          | DELETE /users/:username/{follow,block}`, `GET /users/me/blocked`, `GET /users/deleted` |
| Buzz             | `GET /feed`, `POST /posts`, `GET                                                                                                                                                                                                                       | PATCH                                                                                  | DELETE /posts/:id`, `POST /posts/:id/vote`, `GET | POST /posts/:id/replies`, `DELETE /replies/:id` |
| Moderation       | `POST /posts/:id/report`, `GET /appeals/:token`, `POST /appeals/:token`                                                                                                                                                                                |
| External content | `GET /news`, `GET /news/:section`, `GET /events`, `GET /events/:section`, `GET /trending`, `GET /trending/:section`, `GET /podcasts`, `GET /podcasts/:section`                                                                                         |
| Notifications    | `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all`, `DELETE /notifications/:id`                                                                                                   |
| Settings         | `GET /settings`, `PATCH /settings`                                                                                                                                                                                                                     |
| Media            | `GET /media/avatars/:id`                                                                                                                                                                                                                               |
| Admin            | `POST /admin/auth/login`, `POST /admin/auth/logout`, `GET /admin/auth/me`, `GET /admin/{overview,users,users/:id,moderation/cases,moderation/cases/:id/decision,sources,sources/:key/refresh,health,jobs,audit-logs}`, `DELETE /admin/audit-logs`      |
| Health           | `GET /health`, `GET /health/live`                                                                                                                                                                                                                      |

List endpoints return `{ "data": [...], "meta": { ... } }`; single resources return
`{ "data": { ... } }`. Errors always return `{ "error": { "code", "message", "details?" } }`.

---

## 12. External integrations

### Work without any API key

- News sections (RSS/Atom): The Verge, TechCrunch, The Register, Hugging Face, arXiv,
  BleepingComputer, The Hacker News, OpenAI, Google Developers, Microsoft DevBlogs, Cloudflare,
  AWS, Netflix, Google Cloud, Google News India, Inc42.
- Events: hackathons feed, LeetCode, CodeChef, Codeforces, CTFtime.
- Trending: GitHub repositories, Hugging Face models and datasets, Papers with Code.
- Podcasts: The Changelog, freeCodeCamp, Software Engineering Daily, InfoQ, Syntax. Each feed is
  read only far enough to collect its newest 20 episodes.

### Need a key or account

| Integration       | Needs                  | Without it                                                                                                              |
| ----------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Report moderation | `OPENAI_API_KEY`       | Reports are recorded, the case stays `PROVIDER_FAILED`, the post stays visible and the job retries. Nothing is deleted. |
| Post editing      | `OPENAI_API_KEY`       | Edits are refused with HTTP 503, because an edited post must pass a content check before it becomes visible.            |
| YouTube trending  | `YOUTUBE_API_KEY`      | The YouTube source records a failure and the section is hidden when empty.                                              |
| Email             | SMTP settings          | `EMAIL_TRANSPORT=json` records deliveries without sending.                                                              |
| Link previews     | `LINK_PREVIEW_API_KEY` | Previews are skipped; feed metadata is used and missing fields stay empty.                                              |

### Link previews (linkpreview.net)

News uses feed metadata first. A preview is requested **only** when a feed item is missing its
summary or its image, and only for the news module — never for Buzz posts.

1. Create a free account at <https://www.linkpreview.net/> and copy the API key.
2. Set it in `.env`:

```dotenv
LINK_PREVIEW_API_URL=https://api.linkpreview.net/
LINK_PREVIEW_API_KEY=your-key
LINK_PREVIEW_DAILY_LIMIT=100
```

3. Restart the worker so the next news refresh picks it up.

How the integration behaves:

- Request shape: `GET https://api.linkpreview.net/?q=<percent-encoded url>` with the
  `X-Linkpreview-Api-Key` header, exactly as documented.
- Successful results are cached in `LinkPreviewCache` for 7 days, so repeat refreshes cost nothing.
- At most 8 lookups per source per refresh, at most one per host (the provider allows 1 request
  per second per domain), and `LINK_PREVIEW_DAILY_LIMIT` requests per rolling 24 hours in total.
  Raise the limit only if your plan allows it.
- Provider errors degrade quietly: `401`/`403` logs "API key was rejected", `423` (robots.txt),
  `426` (per-domain limit), `429` (quota) and `503` are logged and the item keeps whatever the feed
  provided. No post or article is ever removed because a preview failed.

---

## 13. Project layout

```text
backend/
├── prisma/
│   ├── schema.prisma           # data model
│   └── migrations/             # committed SQL migrations
├── src/
│   ├── app.ts                  # Fastify instance, plugins, route registration
│   ├── server.ts               # API entry point
│   ├── worker.ts               # worker entry point
│   ├── config/                 # env validation, constants
│   ├── lib/                    # prisma, logger, errors, crypto, SSRF, rich text, rate limits
│   ├── plugins/                # user auth (cookie + bearer + CSRF), admin auth
│   ├── modules/
│   │   ├── auth/               # registration, login, sessions, password reset, deletion
│   │   ├── users/              # profiles, avatars, follows, blocks
│   │   ├── posts/              # posts, feed, votes, replies, reposts
│   │   ├── moderation/         # reports, provider, cases, appeals, warnings, bans
│   │   ├── external/           # feed parsing, source adapters, caching, pagination
│   │   ├── notifications/      # in-app notifications
│   │   ├── settings/           # user preferences
│   │   ├── email/              # templates + Nodemailer transport
│   │   ├── storage/            # local storage driver, avatar generation, image processing
│   │   ├── admin/              # admin API, audit log
│   │   └── health/             # health endpoints
│   ├── jobs/                   # pg-boss bootstrap, queues, schedules, handlers
│   └── cli/                    # admin bootstrap and password change
├── tests/                      # Vitest suites + helpers
├── .env.example
├── .gitignore
└── README.md
```

---

## 14. Behaviour worth knowing

- **Registration** is two-phase: email OTP (10 minutes, single use, resend invalidates the old
  code) then username/display name/password. The username can never change.
- **Sessions** are opaque random tokens; only a SHA-256 hash is stored. Lifetime is fixed at 90
  days with no sliding extension. Password changes and password resets revoke every session.
- **Login throttling** counts failures per (identifier, IP) pair, so an attacker cannot lock a
  victim out from a different address. Five failures in 30 minutes trigger a one-hour cooldown.
- **Votes** are serialised per post with a row lock inside a transaction that also recomputes the
  denormalised score, so concurrent votes cannot drift.
- **Replies** are capped at 10 per user per root post. The check runs under a PostgreSQL advisory
  lock keyed by (post, author), so concurrent requests cannot exceed the cap. Deleting a reply
  frees its slot.
- **Posts** are capped at 5 per user per hour including reposts; replies are not counted.
- **Moderation is report-driven.** New posts publish immediately and are never checked up front.
  A report opens a case and the text is checked against per-category score thresholds. Every
  threshold sits below `0.4`, graded by severity from `0.15` (`sexual/minors`) through `0.36`
  (`harassment`) to a `0.38` default for any category the provider reports without its own entry.
  - If it passes, the post stays public and **the case and its reports are deleted**: no
    notification, no audit entry, nothing in the admin console. That revision is then left alone
    for `REPORT_RECHECK_COOLDOWN_HOURS` (6h), so reports cannot be used to drive repeated checks.
  - If it fails, the post is hidden, the author is notified privately and receives a seven-day
    appeal link.
  - An appeal is the only thing that reaches a moderator. `/admin/moderation/cases` and the
    dashboard counters are restricted to cases with `appealedAt` set, so automated outcomes never
    appear in the admin portal.
  - A post that is not appealed is **deleted permanently** with its replies, votes, mentions,
    reports and reposts, and the case is deleted with it: the warning is the only record kept.
  - A rejected appeal removes the post the same way, but keeps the case (detached, with a title
    snapshot) for 30 days so the decision can be reviewed.
- **Reports target a revision.** Editing a post increments its version, so a post that was
  already reviewed can be reported again. Duplicate reports for the same revision are rejected
  while its case is open, and a cleared revision is not re-checked during the cooldown.
- **Report limits.** 20 per hour per client at the route, plus `REPORT_DAILY_LIMIT` (25) per
  account per day; exceeding either returns 429.
- **Retention.** Resolved cases, their reports and their audit entries are deleted 30 days after
  the decision. Author-deleted posts stay as placeholders only while a reply or repost references
  them; after 30 days with nothing attached they are deleted too.
- **Warnings** stay active for 150 days. Two active warnings trigger a one-day ban, then 3, 7, 14,
  30, 60 days, and a permanent ban from the eighth warning.
- **Account deletion** starts a 7-day recovery window, revokes sessions, and afterwards anonymises
  posts as **Squashed Bug**, releases the username and deletes personal data.
- **Timestamps** are stored as `timestamptz` in UTC. The API returns ISO-8601 strings; clients
  convert to the user's timezone.

---

## 15. Troubleshooting

| Symptom                                             | Cause and fix                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Invalid environment configuration: - DATABASE_URL` | `.env` is missing or not in `backend/`. Copy `.env.example` to `.env`.                                         |
| `Can't reach database server at localhost:5432`     | PostgreSQL is not running. Start the service (`services.msc` → `postgresql-x64-18`).                           |
| `password authentication failed for user "bnb"`     | The password in `DATABASE_URL` does not match the role. Re-run `ALTER ROLE bnb PASSWORD '...';` as `postgres`. |
| `database "bnb" does not exist`                     | Run the `CREATE DATABASE` statements from section 3.                                                           |
| Prisma shadow database error                        | The `bnb` role needs `CREATEDB`. Run `ALTER ROLE bnb CREATEDB;` as `postgres`.                                 |
| `Could not load the "sharp" module`                 | `npm install --include=optional sharp`.                                                                        |
| Tests refuse to run                                 | The test database name must end with `_test`. Check `DATABASE_URL`/`TEST_DATABASE_URL`.                        |
| `/api/v1/health` shows `worker: down`               | Start `npm run dev:worker`.                                                                                    |
| No emails arrive                                    | `EMAIL_TRANSPORT=json` does not send. Configure SMTP or check `EmailDelivery` rows.                            |
| News/trending sections are empty                    | The worker has not refreshed yet. Wait for the first scheduled run or force a refresh from the admin API.      |
| Editing a post returns 503                          | `OPENAI_API_KEY` is not configured; edits require a content check.                                             |
| `EADDRINUSE :4000`                                  | Another process uses the port. Change `API_PORT` or stop the other process.                                    |

---

## 16. Data loss risk — no automated backups

**This project intentionally has no automated database backups.** That was an explicit product
decision, and it applies after public launch as well.

Consequences you are accepting:

- A dropped database, a failed migration, a disk failure, an accidental `DELETE`, or a lost
  hosting volume means **permanent, unrecoverable data loss**.
- Prisma migrations preserve data when they are additive, but a destructive migration (dropping a
  column or table) destroys that data immediately and irreversibly.
- `prisma migrate reset` and `prisma db push --force-reset` wipe the schema and all rows.

If you later want protection, the cheapest options are a scheduled `pg_dump` to a machine you
control, or the free tier of a managed PostgreSQL provider. Nothing in this repository does that
for you.

---

## 17. Known limitations

- Post editing requires `OPENAI_API_KEY`; without it edits are refused rather than published
  unchecked.
- With `OPENAI_API_KEY` unset, reports open a case that stays `PROVIDER_FAILED` until a key is
  configured. Posts are unaffected: moderation never gates publishing.
- The link-preview integration uses linkpreview.net and is bounded by `LINK_PREVIEW_DAILY_LIMIT`;
  free-plan quotas are not published, so raise the limit only if your dashboard allows it.
- `STORAGE_DRIVER=local` writes avatars to disk. The `StorageService` interface exists so object
  storage can replace it later, but no S3/Cloudinary driver is included.
- The admin has no email address, so appeal notifications reach the admin through the moderation
  queue and audit log rather than email.
- The Register's documented feed path (`/headlines.ato`) returns HTTP 404; the adapter falls back
  to `/headlines.atom`, which serves the same content.
- No automated backups (see section 16).
- Deployment files (Docker, CI, reverse proxy) are intentionally out of scope.
