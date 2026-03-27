# PaperBrain

Upload photos or PDFs of handwritten notes, and let Claude AI transcribe, organize, and connect them — all synced across your devices.

## Features

- **Upload & Transcribe** — Drag-drop images or PDFs, or use your phone camera. Claude reads the handwriting and produces clean organized notes.
- **AI Handwriting Learning** — Edit any transcription mistake; the app learns your handwriting style over time to improve accuracy.
- **Visual Annotations** — Draw rectangles, ellipses, or freehand over regions of an image and tag them. Re-process a region for focused AI extraction.
- **Mind Map** — Force-directed graph showing notes and their tag/relation connections. Drag nodes, pin positions, filter by tag.
- **Cross-device Sync** — Account system via Supabase Auth; notes and images stored in the cloud.

---

## Setup

### 1 — Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → New project
2. Copy your **Project URL** and **anon (public) key** from *Project Settings → API*

### 2 — Run the database migration

In the Supabase Dashboard → **SQL Editor**, paste and run the contents of:

```
supabase/migrations/001_initial.sql
```

This creates all tables, RLS policies, and triggers.

### 3 — Create the Storage bucket

In the Dashboard → **Storage**:

1. Click **New bucket** → name: `note-images` → **Public: OFF** → Create
2. Go to **Policies** on the `note-images` bucket and add three policies (INSERT / SELECT / DELETE) with this condition:

```sql
((auth.uid())::text = (storage.foldername(name))[1])
```

This ensures users can only access their own folder (`<user_id>/<note_id>/`).

### 4 — Deploy the Edge Functions

Install the [Supabase CLI](https://supabase.com/docs/guides/cli) if you haven't, then:

```bash
supabase login
supabase link --project-ref <your-project-ref>

# Set your Anthropic API key as a secret
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# Deploy all three functions
supabase functions deploy process-note
supabase functions deploy find-relations
supabase functions deploy learn-handwriting
```

### 5 — Configure the frontend

Edit `config.js` with your project details:

```js
window.PAPERBRAIN_CONFIG = {
  supabaseUrl:     "https://your-project.supabase.co",
  supabaseAnonKey: "eyJ...",
};
```

> **Note:** The anon key is safe to expose in the browser — Supabase RLS protects all data.

### 6 — Deploy to GitHub Pages

Push to the `main` branch. The included GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys the repo root to GitHub Pages automatically.

---

## Development (local)

No build step required — the app is plain HTML/CSS/JS ES modules. Open `index.html` in a browser (via a local server, e.g. `npx serve .`) after filling in `config.js`.

---

## Architecture

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS ES modules, D3.js (mind map), PDF.js, marked.js |
| Auth | Supabase Auth (email/password) |
| Database | Supabase PostgreSQL with Row Level Security |
| File storage | Supabase Storage (private bucket) |
| AI calls | Supabase Edge Functions (Deno) → Anthropic API |
| Hosting | GitHub Pages |

The Anthropic API key lives only in the Edge Function secret — it is never sent to the browser.
