-- Numeric corrections for the 24 synthetic classroom orders only.
-- New table: does not alter the earlier review-status table or student work.
-- Rerunning this setup preserves all existing corrections and their revisions.
begin;

create table if not exists public.ie_action_lab_order_values (
  record_id text primary key check (record_id in ('NS-1041', 'NS-1042', 'NS-1043', 'NS-1044', 'NS-1045', 'NS-1046', 'NS-1047', 'NS-1048', 'NS-1049', 'NS-1050', 'NS-1051', 'NS-1052', 'NS-1053', 'NS-1054', 'NS-1055', 'NS-1056', 'NS-1057', 'NS-1058', 'NS-1059', 'NS-1060', 'NS-1061', 'NS-1062', 'NS-1063', 'NS-1064')),
  revenue numeric not null check (revenue between 0 and 1000000000),
  cost numeric not null check (cost between 0 and 1000000000),
  refund numeric not null check (refund between 0 and 1000000000),
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  updated_at timestamptz not null default now(),
  update_reason text,
  last_request_id uuid,
  last_change_field text,
  last_previous_value numeric,
  last_new_value numeric,
  last_expected_revision bigint,
  constraint ie_action_lab_refund_within_revenue check (refund <= revenue),
  constraint ie_action_lab_numeric_change_metadata check (
    (revision = 0 and update_reason is null and last_request_id is null
      and last_change_field is null and last_previous_value is null
      and last_new_value is null and last_expected_revision is null)
    or
    (revision > 0 and update_reason is not null
      and char_length(btrim(update_reason)) between 5 and 600
      and last_request_id is not null and last_change_field is not null
      and last_change_field in ('revenue', 'cost', 'refund')
      and last_previous_value is not null and last_previous_value between 0 and 1000000000
      and last_new_value is not null and last_new_value between 0 and 1000000000
      and last_previous_value <> last_new_value
      and last_expected_revision is not null and last_expected_revision = revision - 1
      and case last_change_field
        when 'revenue' then revenue = last_new_value
        when 'cost' then cost = last_new_value
        when 'refund' then refund = last_new_value
        else false
      end)
  )
);

comment on table public.ie_action_lab_order_values is
  'Synthetic order numbers with revision-based compare-and-swap; latest request metadata is not a complete audit log.';

alter table public.ie_action_lab_order_values enable row level security;
revoke all on table public.ie_action_lab_order_values from public, anon, authenticated, service_role;
grant select, update on table public.ie_action_lab_order_values to service_role;
-- No browser role has a grant or policy. The authorized Edge Function is the writer.

insert into public.ie_action_lab_order_values (record_id, revenue, cost, refund)
values
  ('NS-1041', 1200, 1320, 0),
  ('NS-1042', 360, 180, 0),
  ('NS-1043', 1350, 810, 0),
  ('NS-1044', 720, 396, 36),
  ('NS-1045', 960, 528, 0),
  ('NS-1046', 500, 275, 0),
  ('NS-1047', 850, 425, 0),
  ('NS-1048', 900, 600, 450),
  ('NS-1049', 1750, 1050, 0),
  ('NS-1050', 400, 160, 0),
  ('NS-1051', 1120, 616, 0),
  ('NS-1052', 2000, 900, 600),
  ('NS-1053', 640, 288, 32),
  ('NS-1054', 680, 374, 0),
  ('NS-1055', 640, 700, 0),
  ('NS-1056', 1000, 580, 50),
  ('NS-1057', 720, 324, 0),
  ('NS-1058', 550, 275, 0),
  ('NS-1059', 840, 462, 0),
  ('NS-1060', 1200, 450, 300),
  ('NS-1061', 450, 180, 0),
  ('NS-1062', 780, 429, 0),
  ('NS-1063', 560, 252, 0),
  ('NS-1064', 810, 405, 0)
on conflict (record_id) do nothing;

commit;
