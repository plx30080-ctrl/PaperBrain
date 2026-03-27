/**
 * learn-handwriting — Supabase Edge Function
 *
 * Accepts user corrections (original AI text → corrected text),
 * stores them, and when enough accumulate, calls Claude to synthesize
 * a compact handwriting style guide stored on the user's profile.
 *
 * Also handles the post-processing clarification flow:
 * when the AI flags [unclear] tokens, the frontend sends cropped image +
 * user-provided word so we can record a targeted correction.
 *
 * POST /functions/v1/learn-handwriting
 * Auth: Bearer <supabase-access-token>
 * Body:
 *   {
 *     noteId: string,
 *     corrections: [{ original: string, correction: string, context?: string }],
 *     // OR for clarification popup:
 *     clarifications: [{ croppedImage: string, word: string, context?: string }]
 *   }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VER = "2023-06-01";
const SYNTHESIZE_THRESHOLD = 5; // synthesize after every N new corrections
const MAX_CONTEXT_CHARS = 600;

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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { authorization: authHeader } } },
    );

    const { data: { user }, error: authErr } = await admin.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const { noteId, corrections = [], clarifications = [] } = body as {
      noteId: string;
      corrections: { original: string; correction: string; context?: string }[];
      clarifications: { croppedImage: string; word: string; context?: string }[];
    };

    // ── Convert clarifications → corrections ──────────────────
    // "[unclear]" in context → user-supplied word
    const clarificationRows = clarifications.map((c) => ({
      user_id: user.id,
      note_id: noteId ?? null,
      original: "[unclear]",
      correction: c.word,
      context_snippet: c.context ?? null,
    }));

    const correctionRows = corrections.map((c) => ({
      user_id: user.id,
      note_id: noteId ?? null,
      original: c.original,
      correction: c.correction,
      context_snippet: c.context ?? null,
    }));

    const allRows = [...correctionRows, ...clarificationRows];
    if (!allRows.length) return json({ ok: true, synthesized: false });

    const { error: insErr } = await admin
      .from("handwriting_corrections")
      .insert(allRows);
    if (insErr) throw insErr;

    // ── Count total uncondensed corrections ───────────────────
    const { count } = await admin
      .from("handwriting_corrections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    const total = count ?? 0;
    const shouldSynthesize = total > 0 && total % SYNTHESIZE_THRESHOLD === 0;

    if (!shouldSynthesize) {
      return json({ ok: true, synthesized: false, total });
    }

    // ── Load recent corrections for synthesis ─────────────────
    const { data: recent } = await admin
      .from("handwriting_corrections")
      .select("original, correction, context_snippet")
      .eq("user_id", user.id)
      .order("applied_at", { ascending: false })
      .limit(30);

    const examples = (recent ?? [])
      .map((r) =>
        `• AI read: "${r.original}" → User wrote: "${r.correction}"${
          r.context_snippet ? ` (context: "…${r.context_snippet}…")` : ""
        }`
      )
      .join("\n");

    // ── Fetch existing context ────────────────────────────────
    const { data: profile } = await admin
      .from("profiles")
      .select("handwriting_context, model")
      .eq("id", user.id)
      .single();

    const existing = profile?.handwriting_context ?? "";

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

    const prompt =
      `You are analyzing handwriting corrections to build a compact style guide.

${existing ? `EXISTING STYLE GUIDE (to update, not replace):\n${existing}\n\n` : ""}RECENT CORRECTIONS:
${examples}

Based on these corrections, extract concise, actionable style notes that will help an AI better read this person's handwriting in the future. Focus on:
- Letter shapes that are commonly confused (e.g., "a looks like o")
- Punctuation habits (e.g., "rarely dots i")
- Word-level patterns (specific words often misread)
- Any systematic substitutions

Return a SINGLE compact paragraph (max 4 sentences, under ${MAX_CONTEXT_CHARS} characters) that can be prepended to future transcription prompts. Write in third person ("User's handwriting..."). Return ONLY the paragraph text, nothing else.`;

    const aiRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": ANTHROPIC_VER,
      },
      body: JSON.stringify({
        model: profile?.model ?? "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [{ type: "text", text: prompt }],
        }],
      }),
    });

    if (!aiRes.ok) throw new Error(`Anthropic ${aiRes.status}`);
    const aiData = await aiRes.json();
    let newContext: string = aiData.content[0].text.trim();

    // Enforce length limit
    if (newContext.length > MAX_CONTEXT_CHARS) {
      newContext = newContext.slice(0, MAX_CONTEXT_CHARS).trim();
    }

    await admin
      .from("profiles")
      .update({ handwriting_context: newContext })
      .eq("id", user.id);

    return json({ ok: true, synthesized: true, context: newContext, total });
  } catch (err) {
    console.error("[learn-handwriting]", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
