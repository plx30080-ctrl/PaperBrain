-- ============================================================
--  PaperBrain – complete database schema
--  Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- ── user_profiles ──────────────────────────────────────────
create table public.user_profiles (
  id                 uuid primary key references auth.users on delete cascade,
  email              text,
  api_key            text,
  model              text        not null default 'claude-sonnet-4-6',
  theme              text        not null default 'light',
  handwriting_notes  text        not null default '',
  correction_count   integer     not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.user_profiles enable row level security;
create policy "own profile"
  on public.user_profiles for all
  using  (auth.uid() = id)
  with check (auth.uid() = id);

-- Auto-create a profile row when a new user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── notes ──────────────────────────────────────────────────
create table public.notes (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users on delete cascade,
  title            text        not null default 'Untitled Note',
  transcription    text        not null default '',
  organized        text        not null default '',
  summary          text        not null default '',
  tags             text[]      not null default '{}',
  key_points       text[]      not null default '{}',
  annotations      jsonb       not null default '[]',
  source_type      text        not null default 'image' check (source_type in ('image','pdf')),
  processing_state text        not null default 'done',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index notes_user_date_idx on public.notes (user_id, created_at desc);
create index notes_tags_gin_idx  on public.notes using gin(tags);

alter table public.notes enable row level security;
create policy "own notes"
  on public.notes for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── note_images ─────────────────────────────────────────────
create table public.note_images (
  id           uuid        primary key default gen_random_uuid(),
  note_id      uuid        not null references public.notes on delete cascade,
  user_id      uuid        not null references auth.users on delete cascade,
  storage_path text        not null,
  page_number  integer     not null default 1,
  created_at   timestamptz not null default now()
);

create index note_images_note_idx on public.note_images (note_id, page_number);

alter table public.note_images enable row level security;
create policy "own note_images"
  on public.note_images for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── note_relations ───────────────────────────────────────────
create table public.note_relations (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users on delete cascade,
  from_id    uuid        not null references public.notes on delete cascade,
  to_id      uuid        not null references public.notes on delete cascade,
  score      real        not null default 0 check (score between 0 and 1),
  reason     text        not null default '',
  created_at timestamptz not null default now(),
  unique(from_id, to_id)
);

create index note_relations_from_idx on public.note_relations (from_id);
create index note_relations_to_idx   on public.note_relations (to_id);

alter table public.note_relations enable row level security;
create policy "own relations"
  on public.note_relations for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── transcription_corrections (AI learning) ─────────────────
create table public.transcription_corrections (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users on delete cascade,
  note_id          uuid        references public.notes on delete set null,
  field            text        not null default 'transcription',
  original_text    text        not null,
  corrected_text   text        not null,
  created_at       timestamptz not null default now()
);

create index corrections_user_idx on public.transcription_corrections (user_id, created_at desc);

alter table public.transcription_corrections enable row level security;
create policy "own corrections"
  on public.transcription_corrections for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── tag_map_nodes (persisted layout positions) ──────────────
create table public.tag_map_nodes (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users on delete cascade,
  node_type  text        not null check (node_type in ('note','tag')),
  node_ref   text        not null,
  x          real        not null default 0,
  y          real        not null default 0,
  pinned     boolean     not null default false,
  updated_at timestamptz not null default now(),
  unique(user_id, node_type, node_ref)
);

alter table public.tag_map_nodes enable row level security;
create policy "own map nodes"
  on public.tag_map_nodes for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── tag_map_connections (user-drawn links) ───────────────────
create table public.tag_map_connections (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users on delete cascade,
  from_ref   text        not null,
  to_ref     text        not null,
  label      text        not null default '',
  color      text        not null default '#6366f1',
  created_at timestamptz not null default now(),
  unique(user_id, from_ref, to_ref)
);

alter table public.tag_map_connections enable row level security;
create policy "own map connections"
  on public.tag_map_connections for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Storage bucket ───────────────────────────────────────────
-- Run this separately or via the Supabase Dashboard:
-- 1. Go to Storage → Create bucket → name: "note-images", public: false
-- 2. Add the following policies in Storage → Policies:

-- insert policy (users upload to own folder):
--   ((auth.uid())::text = (storage.foldername(name))[1])

-- select policy (users read from own folder):
--   ((auth.uid())::text = (storage.foldername(name))[1])

-- delete policy (users delete from own folder):
--   ((auth.uid())::text = (storage.foldername(name))[1])
