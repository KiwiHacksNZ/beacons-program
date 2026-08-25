# Beacons Database Manual Setup

This document describes the database configuration that must exist outside the Beacons application. The configured NocoDB data source is PostgreSQL. NocoDB may expose some of these settings in its field editor, but its standard interface may not support composite unique indexes or all relational constraints.

Do not consider the database production-ready until every item in the verification checklist passes.

## Current audit result

The read-only audit performed on 26 August 2026 found:

- one valid program and no attendees;
- both required tables and all expected columns exist;
- no invalid, missing, duplicate, or orphaned records;
- NocoDB reports the important non-primary fields as nullable;
- NocoDB does not report any unique fields;
- composite indexes and foreign keys are not confirmed.

Because the attendee table is empty, this is the safest time to apply the constraints.

## 1. Settings to add manually

### `programs`

| Field | Required / NOT NULL | Unique | Default | Other rule |
| --- | --- | --- | --- | --- |
| `Id` | Already handled by NocoDB | Primary key | Automatic | No change |
| `name` | Yes | No | None | Non-empty, maximum 120 characters |
| `public_slug` | Yes | Yes | None | Must match `bp_` followed by 24 URL-safe characters |
| `webhook_secret_hash` | Yes | No | None | Exactly 64 lowercase hexadecimal characters |
| `loops_transactional_id` | No | No | `NULL` | If present, letters, numbers, `_`, and `-` only |
| `active` | Yes | No | `true` | Boolean |

### `attendees`

| Field | Required / NOT NULL | Unique | Default | Other rule |
| --- | --- | --- | --- | --- |
| `Id` | Already handled by NocoDB | Primary key | Automatic | No change |
| `program_slug` | Yes | Only as part of composite keys | None | Must reference an existing program |
| `first_name` | Yes | No | None | Non-empty, maximum 100 characters |
| `last_name` | Yes | No | None | Non-empty, maximum 100 characters |
| `preferred_name` | No | No | `NULL` | Maximum 100 characters |
| `email` | Yes | Only as part of a composite key | None | Lowercase normalized email |
| `email_normalized` | Yes | Unique within one program | None | Must equal `email` |
| `owned_referral_code` | Yes | Unique within one program | None | Uppercase letters, numbers, `_`, and `-` only |
| `referral_code_used` | No | No | `NULL` | If present, must belong to an attendee in the same program |

## 2. What can be attempted in NocoDB

For each table, open the field menu using the arrow beside the field name and select **Edit field**. Depending on the NocoDB version and field type, the editor may expose:

- **NN** or **Not Null** for required fields;
- **Default Value**, where `active` should default to `true`;
- **Unique values only**, which can be enabled for `programs.public_slug` if available.

NocoDB's field UI is not sufficient unless it can also create both composite unique indexes and the foreign keys listed below. If any option is missing, apply the PostgreSQL SQL in the next section.

## 3. PostgreSQL constraints

Run this against the PostgreSQL database connected to NocoDB, using pgAdmin, DBeaver, another PostgreSQL administration tool, or `psql` in the PostgreSQL container.

The table metadata did not report a custom schema, so the SQL uses the connection's normal search path. If the tables are not in `public`, qualify `programs` and `attendees` with the correct schema name.

Take a database backup before running schema changes.

```sql
BEGIN;

-- Required fields and defaults.
ALTER TABLE programs
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN public_slug SET NOT NULL,
  ALTER COLUMN webhook_secret_hash SET NOT NULL,
  ALTER COLUMN active SET DEFAULT true,
  ALTER COLUMN active SET NOT NULL;

ALTER TABLE attendees
  ALTER COLUMN program_slug SET NOT NULL,
  ALTER COLUMN first_name SET NOT NULL,
  ALTER COLUMN last_name SET NOT NULL,
  ALTER COLUMN email SET NOT NULL,
  ALTER COLUMN email_normalized SET NOT NULL,
  ALTER COLUMN owned_referral_code SET NOT NULL;

-- Uniqueness. These indexes are safe to run again because IF NOT EXISTS is used.
CREATE UNIQUE INDEX IF NOT EXISTS programs_public_slug_uidx
  ON programs (public_slug);

CREATE UNIQUE INDEX IF NOT EXISTS attendees_program_email_uidx
  ON attendees (program_slug, email_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS attendees_program_owned_code_uidx
  ON attendees (program_slug, owned_referral_code);

-- Format and consistency checks. Add each named constraint only once.
ALTER TABLE programs
  ADD CONSTRAINT programs_name_valid_chk
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  ADD CONSTRAINT programs_public_slug_format_chk
    CHECK (public_slug ~ '^bp_[A-Za-z0-9_-]{24}$'),
  ADD CONSTRAINT programs_webhook_hash_format_chk
    CHECK (webhook_secret_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT programs_loops_id_format_chk
    CHECK (
      loops_transactional_id IS NULL
      OR loops_transactional_id ~ '^[A-Za-z0-9_-]{1,128}$'
    );

ALTER TABLE attendees
  ADD CONSTRAINT attendees_first_name_valid_chk
    CHECK (char_length(btrim(first_name)) BETWEEN 1 AND 100),
  ADD CONSTRAINT attendees_last_name_valid_chk
    CHECK (char_length(btrim(last_name)) BETWEEN 1 AND 100),
  ADD CONSTRAINT attendees_preferred_name_valid_chk
    CHECK (
      preferred_name IS NULL
      OR char_length(btrim(preferred_name)) BETWEEN 1 AND 100
    ),
  ADD CONSTRAINT attendees_email_normalized_chk
    CHECK (
      email = email_normalized
      AND email_normalized = lower(btrim(email_normalized))
    ),
  ADD CONSTRAINT attendees_owned_code_format_chk
    CHECK (owned_referral_code ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  ADD CONSTRAINT attendees_used_code_format_chk
    CHECK (
      referral_code_used IS NULL
      OR referral_code_used ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'
    );

-- Every attendee must belong to an existing program.
ALTER TABLE attendees
  ADD CONSTRAINT attendees_program_slug_fk
  FOREIGN KEY (program_slug)
  REFERENCES programs (public_slug)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;

-- A used referral code must resolve inside the same program.
ALTER TABLE attendees
  ADD CONSTRAINT attendees_same_program_referral_fk
  FOREIGN KEY (program_slug, referral_code_used)
  REFERENCES attendees (program_slug, owned_referral_code)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;

COMMIT;
```

The named `CHECK` and foreign-key constraints do not use `IF NOT EXISTS`. Run that section once. If PostgreSQL reports that a constraint name already exists, inspect the existing constraint instead of deleting it blindly.

## 4. Where to run the SQL in Portainer

If PostgreSQL is a container managed by Portainer:

1. Open **Portainer → Containers**.
2. Select the PostgreSQL container, not the Beacons or NocoDB container.
3. Open **Console** and connect using `/bin/sh` or `/bin/bash`.
4. Start PostgreSQL's console:

   ```sh
   psql -U POSTGRES_USER -d DATABASE_NAME
   ```

5. Paste the transaction from the previous section.
6. Confirm that it ends with `COMMIT` and no error.

The PostgreSQL username and database name normally come from the PostgreSQL/NocoDB stack environment, often under names such as `POSTGRES_USER` and `POSTGRES_DB`. Do not copy those credentials into this repository.

## 5. Synchronize NocoDB afterward

After changing PostgreSQL directly:

1. Open the Beacons base in NocoDB.
2. Open **Base home → Data Sources**.
3. Select the PostgreSQL data source.
4. Open **Meta Sync**.
5. Click **Reload**.
6. Review the detected changes and click **Sync Now**.

Do not recreate or rename the tables or fields.

## 6. Verification queries

Run these after applying the constraints. They display schema information and counts, not attendee details.

### Confirm required fields and defaults

```sql
SELECT
  table_name,
  column_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name IN ('programs', 'attendees')
ORDER BY table_name, ordinal_position;
```

The required columns listed above must show `is_nullable = 'NO'`. `programs.active` must have a `true` default.

### Confirm indexes

```sql
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('programs', 'attendees')
ORDER BY tablename, indexname;
```

The output must include:

- `programs_public_slug_uidx`;
- `attendees_program_email_uidx`;
- `attendees_program_owned_code_uidx`.

### Confirm checks and foreign keys

```sql
SELECT
  conrelid::regclass AS table_name,
  conname AS constraint_name,
  contype AS constraint_type
FROM pg_constraint
WHERE conrelid IN ('programs'::regclass, 'attendees'::regclass)
ORDER BY table_name, constraint_name;
```

PostgreSQL reports check constraints as `c` and foreign keys as `f`. Confirm both attendee foreign keys and all named checks are present.

## 7. Final application check

After PostgreSQL and NocoDB are synchronized, run the protected readiness endpoint:

```sh
curl --fail --silent --show-error \
  --header "Authorization: Bearer YOUR_HEALTHCHECK_SECRET" \
  https://YOUR-BACKEND/internal/health/db
```

Expected response:

```json
{"ok":true}
```

Then create test signups through Fillout. Confirm duplicate emails and cross-program referral codes are rejected or ignored as described in the launch checklist.

