/**
 * find-relations — Supabase Edge Function
 *
 * Finds related notes for a newly created note using Claude.
 * Called in the background after a note is saved.
 *
 * POST /functions/v1/find-relations
 * Auth: Bearer <supabase-access-token>
 * Body: { noteId: string }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VER = "2023-06-01";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: { user }, error: authErr } =
      await supabase.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const { noteId } = await req.json();
    if (!noteId) return json({ error: "noteId required" }, 400);

    // ── Load the new note ─────────────────────────────────────
    const { data: newNote } = await supabase
      .from("notes")
      .select("id, title, summary, tags")
      .eq("id", noteId)
      .eq("user_id", user.id)
      .single();

    if (!newNote) return json({ error: "Note not found" }, 404);

    // ── Load up to 40 other notes for comparison ──────────────
    const { data: candidates } = await supabase
      .from("notes")
      .select("id, title, summary, tags")
      .eq("user_id", user.id)
      .neq("id", noteId)
      .eq("processing_state", "done")
      .order("created_at", { ascending: false })
      .limit(40);

    if (!candidates?.length) return json({ ok: true, relations: [] });

    // ── Call Claude ───────────────────────────────────────────
    const prompt =
      `You are finding connections between notes.

NEW NOTE:
Title: ${newNote.title}
Summary: ${newNote.summary}
Tags: ${(newNote.tags ?? []).join(", ")}

EXISTING NOTES:
${JSON.stringify(candidates.map((n) => ({ id: n.id, title: n.title, summary: n.summary, tags: n.tags })), null, 2)}

Return a JSON array of the most related existing notes (up to 5).
Only include notes with meaningful topical overlap (score ≥ 0.45).

[
  {
    "id": "note-uuid",
    "score": 0.85,
    "reason": "One concise sentence explaining the connection."
  }
]

Return ONLY the JSON array. If no notes are sufficiently related, return [].`;

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
    const { data: profile } = await supabase
      .from("profiles")
      .select("model")
      .eq("id", user.id)
      .single();

    const aiRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": ANTHROPIC_VER,
      },
      body: JSON.stringify({
        model: profile?.model ?? "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [{ type: "text", text: prompt }],
        }],
      }),
    });

    if (!aiRes.ok) throw new Error(`Anthropic ${aiRes.status}`);

    const aiData = await aiRes.json();
    const raw: string = aiData.content[0].text;

    let related: { id: string; score: number; reason: string }[] = [];
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) related = JSON.parse(match[0]);
    } catch (_) {
      related = [];
    }

    if (!related.length) return json({ ok: true, relations: [] });

    // ── Delete old AI relations for this note (keep manual) ───
    await supabase
      .from("relations")
      .delete()
      .eq("from_id", noteId)
      .eq("user_id", user.id)
      .eq("manual", false);

    // ── Save new relations ────────────────────────────────────
    const rows = related.map((r) => ({
      user_id: user.id,
      from_id: noteId,
      to_id: r.id,
      score: Math.min(1, Math.max(0, r.score)),
      reason: r.reason,
      manual: false,
    }));

    const { error: relErr } = await supabase.from("relations").insert(rows);
    if (relErr) throw relErr;

    return json({ ok: true, relations: rows });
  } catch (err) {
    console.error("[find-relations]", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
