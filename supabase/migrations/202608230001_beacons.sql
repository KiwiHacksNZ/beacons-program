-- Fresh, dedicated, multi-program KiwiHacks Beacons schema.
-- Deliberately independent from the retired currentdb-DO_NOT_COMMIT.sql dump.

create extension if not exists pgcrypto;

create table public.beacons_programs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  public_slug text not null unique check (public_slug ~ '^bp_[A-Za-z0-9_-]{20,}$'),
  webhook_secret_hash text not null check (webhook_secret_hash ~ '^[a-f0-9]{64}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, public_slug)
);

comment on table public.beacons_programs is
  'Independent Beacons events/programs. Webhook credentials are stored only as SHA-256 hashes.';

create table public.beacons_attendees (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.beacons_programs(id) on delete cascade,
  first_name text not null check (char_length(first_name) between 1 and 100),
  last_name text not null check (char_length(last_name) between 1 and 100),
  preferred_name text check (preferred_name is null or char_length(preferred_name) <= 100),
  email text not null,
  email_normalized text not null,
  owned_referral_code text not null,
  referral_code_used text,
  referrer_id uuid,
  created_at timestamptz not null default now(),
  constraint beacons_email_normalized_lowercase check (email_normalized = lower(btrim(email_normalized))),
  constraint beacons_not_self_referred check (referrer_id is null or referrer_id <> id),
  constraint beacons_attendees_program_email_unique unique (program_id, email_normalized),
  constraint beacons_attendees_program_code_unique unique (program_id, owned_referral_code),
  constraint beacons_attendees_program_id_id_unique unique (program_id, id),
  constraint beacons_referrer_same_program foreign key (program_id, referrer_id)
    references public.beacons_attendees(program_id, id) on delete set null (referrer_id)
);

comment on table public.beacons_attendees is
  'Dedicated Beacons signups; email and owned referral code are unique within one program.';
comment on column public.beacons_attendees.referral_code_used is
  'Normalized submitted code, retained even when it did not match an owner in the same program.';

create index beacons_attendees_program_referrer_idx
  on public.beacons_attendees (program_id, referrer_id)
  where referrer_id is not null;

create table public.beacons_leaderboard_snapshots (
  program_id uuid primary key,
  program_public_slug text not null unique,
  response_json jsonb not null default '[]'::jsonb check (jsonb_typeof(response_json) = 'array'),
  refreshed_at timestamptz not null default now(),
  constraint beacons_snapshot_program_fk foreign key (program_id, program_public_slug)
    references public.beacons_programs(id, public_slug) on update cascade on delete cascade
);

comment on table public.beacons_leaderboard_snapshots is
  'Program-scoped public response cache containing only displayName and referralCount objects.';

alter table public.beacons_programs enable row level security;
alter table public.beacons_attendees enable row level security;
alter table public.beacons_leaderboard_snapshots enable row level security;

revoke all on table public.beacons_programs, public.beacons_attendees, public.beacons_leaderboard_snapshots
  from anon, authenticated, service_role;
grant select on table public.beacons_programs, public.beacons_attendees to service_role;

create or replace view public.beacons_leaderboard
with (security_invoker = true)
as
select
  owner.program_id,
  program.public_slug as program_public_slug,
  coalesce(nullif(btrim(owner.preferred_name), ''), owner.first_name) as display_name,
  count(referred.id)::integer as referral_count
from public.beacons_attendees owner
join public.beacons_programs program on program.id = owner.program_id
join public.beacons_attendees referred
  on referred.program_id = owner.program_id and referred.referrer_id = owner.id
where program.active
group by owner.program_id, program.public_slug, owner.id, owner.preferred_name, owner.first_name
having count(referred.id) > 0;

revoke all on table public.beacons_leaderboard from anon, authenticated, service_role;
grant select on table public.beacons_leaderboard to service_role;

create or replace function public.beacons_refresh_leaderboard(p_program_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_public_slug text;
  v_response jsonb;
begin
  select p.public_slug into v_public_slug
  from public.beacons_programs p
  where p.id = p_program_id;

  if v_public_slug is null then
    raise exception 'Program not found';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('displayName', ranked.display_name, 'referralCount', ranked.referral_count)
      order by ranked.referral_count desc, ranked.display_name asc
    ),
    '[]'::jsonb
  ) into v_response
  from (
    select
      coalesce(nullif(btrim(owner.preferred_name), ''), owner.first_name) as display_name,
      count(referred.id)::integer as referral_count
    from public.beacons_attendees owner
    join public.beacons_attendees referred
      on referred.program_id = owner.program_id and referred.referrer_id = owner.id
    where owner.program_id = p_program_id
    group by owner.id, owner.preferred_name, owner.first_name
    having count(referred.id) > 0
  ) ranked;

  insert into public.beacons_leaderboard_snapshots (
    program_id,
    program_public_slug,
    response_json,
    refreshed_at
  ) values (
    p_program_id,
    v_public_slug,
    v_response,
    now()
  )
  on conflict (program_id) do update set
    program_public_slug = excluded.program_public_slug,
    response_json = excluded.response_json,
    refreshed_at = excluded.refreshed_at;
end;
$$;

revoke all on function public.beacons_refresh_leaderboard(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.beacons_get_leaderboard_snapshot(p_program_public_slug text)
returns table (response_json jsonb)
language sql
security definer
set search_path = public, pg_temp
as $$
  select snapshot.response_json
  from public.beacons_leaderboard_snapshots snapshot
  join public.beacons_programs program on program.id = snapshot.program_id
  where snapshot.program_public_slug = p_program_public_slug
    and program.active;
$$;

revoke all on function public.beacons_get_leaderboard_snapshot(text)
  from public, anon, authenticated;
grant execute on function public.beacons_get_leaderboard_snapshot(text) to service_role;

create or replace function public.beacons_create_program(
  p_name text,
  p_public_slug text,
  p_webhook_secret_hash text
)
returns table (id uuid, name text, public_slug text, active boolean, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_program public.beacons_programs%rowtype;
begin
  insert into public.beacons_programs (name, public_slug, webhook_secret_hash)
  values (btrim(p_name), p_public_slug, lower(p_webhook_secret_hash))
  returning * into v_program;

  perform public.beacons_refresh_leaderboard(v_program.id);
  return query select v_program.id, v_program.name, v_program.public_slug, v_program.active, v_program.created_at;
end;
$$;

revoke all on function public.beacons_create_program(text, text, text)
  from public, anon, authenticated;
grant execute on function public.beacons_create_program(text, text, text) to service_role;

create or replace function public.beacons_rotate_program_secret(
  p_program_id uuid,
  p_webhook_secret_hash text
)
returns table (id uuid, name text, public_slug text, active boolean, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_program public.beacons_programs%rowtype;
begin
  update public.beacons_programs p
  set webhook_secret_hash = lower(p_webhook_secret_hash), updated_at = now()
  where p.id = p_program_id
  returning p.* into v_program;

  if v_program.id is null then return; end if;
  return query select v_program.id, v_program.name, v_program.public_slug, v_program.active, v_program.created_at;
end;
$$;

revoke all on function public.beacons_rotate_program_secret(uuid, text)
  from public, anon, authenticated;
grant execute on function public.beacons_rotate_program_secret(uuid, text) to service_role;

create or replace function public.beacons_accept_signup(
  p_program_public_slug text,
  p_webhook_secret_hash text,
  p_first_name text,
  p_last_name text,
  p_preferred_name text,
  p_email text,
  p_referral_code_used text default null
)
returns table (
  authorized boolean,
  accepted boolean,
  attendee_id uuid,
  owned_referral_code text,
  referral_applied boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_program_id uuid;
  v_email text := lower(btrim(p_email));
  v_used_code text := nullif(upper(btrim(p_referral_code_used)), '');
  v_prefix text;
  v_owned_code text;
  v_referrer_id uuid;
  v_attendee_id uuid;
  v_attempt integer := 0;
begin
  select p.id into v_program_id
  from public.beacons_programs p
  where p.public_slug = p_program_public_slug
    and p.webhook_secret_hash = lower(p_webhook_secret_hash)
    and p.active;

  if v_program_id is null then
    return query select false, false, null::uuid, null::text, false;
    return;
  end if;

  -- Duplicate email means the complete later submission is ignored within this program.
  if exists (
    select 1 from public.beacons_attendees a
    where a.program_id = v_program_id and a.email_normalized = v_email
  ) then
    return query select true, false, null::uuid, null::text, false;
    return;
  end if;

  -- The scoped unique constraint supports this program + code indexed equality lookup.
  if v_used_code is not null then
    select a.id into v_referrer_id
    from public.beacons_attendees a
    where a.program_id = v_program_id and a.owned_referral_code = v_used_code;
  end if;

  v_prefix := left(regexp_replace(upper(btrim(p_first_name)), '[^A-Z0-9]', '', 'g'), 4);
  if v_prefix = '' then v_prefix := 'KIWI'; end if;

  loop
    v_attempt := v_attempt + 1;
    v_owned_code := v_prefix || '-' || upper(encode(gen_random_bytes(6), 'hex'));
    begin
      insert into public.beacons_attendees (
        program_id, first_name, last_name, preferred_name, email, email_normalized,
        owned_referral_code, referral_code_used, referrer_id
      ) values (
        v_program_id, btrim(p_first_name), btrim(p_last_name), nullif(btrim(p_preferred_name), ''),
        btrim(p_email), v_email, v_owned_code, v_used_code, v_referrer_id
      ) returning id into v_attendee_id;

      perform public.beacons_refresh_leaderboard(v_program_id);
      return query select true, true, v_attendee_id, v_owned_code, (v_referrer_id is not null);
      return;
    exception when unique_violation then
      if exists (
        select 1 from public.beacons_attendees a
        where a.program_id = v_program_id and a.email_normalized = v_email
      ) then
        return query select true, false, null::uuid, null::text, false;
        return;
      end if;
      if v_attempt >= 8 then raise exception 'Could not allocate a unique referral code'; end if;
    end;
  end loop;
end;
$$;

revoke all on function public.beacons_accept_signup(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.beacons_accept_signup(text, text, text, text, text, text, text)
  to service_role;

create or replace function public.beacons_health_check()
returns table (ok boolean, server_time timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    exists(select 1 from pg_catalog.pg_class where relname = 'beacons_programs')
    and exists(select 1 from pg_catalog.pg_class where relname = 'beacons_attendees')
    and exists(select 1 from pg_catalog.pg_class where relname = 'beacons_leaderboard_snapshots'),
    now();
$$;

revoke all on function public.beacons_health_check() from public, anon, authenticated;
grant execute on function public.beacons_health_check() to service_role;
