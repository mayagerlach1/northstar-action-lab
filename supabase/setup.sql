-- Isolated synthetic classroom writeback. Run once in your own Supabase project.
-- This script does not read or modify the course portal or other application tables.
begin;

create table public.ie_action_lab_reviews (
  record_id text primary key check (record_id = 'NS-1041'),
  synthetic boolean not null default true check (synthetic = true),
  review_status text not null default 'pending' check (review_status in ('pending', 'reviewed')),
  request_id uuid,
  reviewed_at timestamptz,
  constraint ie_action_lab_review_state_valid check (
    (review_status = 'pending' and request_id is null and reviewed_at is null)
    or (review_status = 'reviewed' and request_id is not null and reviewed_at is not null)
  )
);

comment on table public.ie_action_lab_reviews is
  'Isolated synthetic IE Apps Action Lab fixture: only NS-1041; service-only writeback.';

alter table public.ie_action_lab_reviews enable row level security;
revoke all on table public.ie_action_lab_reviews from public, anon, authenticated;
grant select, insert, update on table public.ie_action_lab_reviews to service_role;
-- No anon/authenticated policies: browser clients have no direct table access.

insert into public.ie_action_lab_reviews (record_id, synthetic, review_status)
values ('NS-1041', true, 'pending');

commit;
