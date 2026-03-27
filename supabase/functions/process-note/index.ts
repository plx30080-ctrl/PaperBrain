/**
 * process-note — Supabase Edge Function
 *
 * Accepts images (base64), calls Anthropic, saves the note + images,
 * then returns the created note record.
 *
 * POST /functions/v1/process-note
 * Auth: Bearer <supabase-access-token>
 * Body:
 *   { images: string[],          // base64 data-URLs
 *     mode?: 'full' | 'region',  // 'region' = single cropped region
 *     tag?: string,              // region tag (mode=region only)
 *     noteId?: string            // existing note to update (mode=region)
 *   }
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
    const accessToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(
      supabaseUrl,
      supabaseAnonKey,
      { global: { headers: { authorization: authHeader } } },
    );

    const user = await getUserFromAccessToken(supabaseUrl, supabaseAnonKey, accessToken);
    if (!user) {
      console.error("[process-note] auth error: invalid token", "header present:", !!authHeader);
      return json({ error: "Unauthorized" }, 401);
    }

    // Admin client for storage uploads and service-level writes
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Fetch user profile (handwriting context + model pref) ─
    const { data: profile } = await admin
      .from("profiles")
      .select("handwriting_context, model")
      .eq("id", user.id)
      .single();

    const hwContext = profile?.handwriting_context ?? "";
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

    // ── Parse request ─────────────────────────────────────────
    const body = await req.json();
    const { images, mode = "full", tag, noteId } = body as {
      images: string[];
      mode?: "full" | "region";
      tag?: string;
      noteId?: string;
    };

    if (!images?.length) return json({ error: "images required" }, 400);

    // ── Build Anthropic content blocks ────────────────────────
    const imageBlocks = images.map((dataUrl: string) => {
      const comma = dataUrl.indexOf(",");
      const meta = dataUrl.slice(5, comma); // strip "data:"
      const [mediaType] = meta.split(";");
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: dataUrl.slice(comma + 1),
        },
      };
    });

    let prompt: string;
    let maxTokens: number;

    if (mode === "region") {
      // ── Region re-process prompt ───────────────────────────
      maxTokens = 1024;
      prompt =
        `You are transcribing a specific annotated region of a handwritten note.
This region is tagged as: "${tag ?? "unlabeled"}".
${hwContext ? `\nHandwriting notes from user corrections:\n${hwContext}\n` : ""}
Please:
1. Transcribe all text visible in this image region verbatim. Mark unclear text as [unclear].
2. Return a short, well-formatted Markdown summary of the content in this region.

Return JSON only:
{
  "transcription": "...",
  "content": "...",
  "tag": "${tag ?? ""}"
}`;
    } else {
      // ── Full note processing prompt ────────────────────────
      maxTokens = 4096;
      const pageWord = images.length > 1
        ? `these ${images.length} pages`
        : "this page";
      prompt =
        `You are an expert at reading handwritten notes and organizing information clearly.
${hwContext ? `\nHandwriting notes from previous user corrections:\n${hwContext}\nPlease apply these style notes when transcribing.\n` : ""}
Analyze ${pageWord} and return JSON with EXACTLY this structure:
{
  "title": "Concise descriptive title, max 60 chars",
  "transcription": "Complete verbatim transcription of all handwritten text. Preserve line breaks. Mark unclear text as [unclear].",
  "organized": "Same content reorganized using Markdown: ## headings, - bullets, **bold key terms**. Group related ideas. Make it scannable.",
  "summary": "2-3 sentence summary of the main ideas and takeaways.",
  "tags": ["3","to","8","lowercase","topic","tags"],
  "keyPoints": ["Key point 1","Key point 2","Key point 3"]
}
Return ONLY the JSON object.`;
    }

    // ── Call Anthropic ─────────────────────────────────────────
    const anthropicRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": ANTHROPIC_VER,
      },
      body: JSON.stringify({
        model: resolveAnthropicModel(profile?.model),
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: [...imageBlocks, { type: "text", text: prompt }],
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json().catch(() => ({}));
      throw new Error(
        err.error?.message ?? `Anthropic error ${anthropicRes.status}`,
      );
    }

    const aiData = await anthropicRes.json();
    const rawText: string = aiData.content[0].text;
    const parsed = parseJSON(rawText);

    // ── Region mode: update annotation & return ───────────────
    if (mode === "region" && noteId) {
      // Store region content on the annotation (caller supplies annotationId)
      return json({ ok: true, region: parsed }, 200);
    }

    // ── Full mode: save note + images to Supabase ─────────────
    const now = new Date().toISOString();

    const { data: note, error: insertErr } = await admin
      .from("notes")
      .insert({
        user_id: user.id,
        title: parsed.title ?? "Untitled",
        transcription: parsed.transcription ?? "",
        organized: parsed.organized ?? "",
        summary: parsed.summary ?? "",
        tags: parsed.tags ?? [],
        key_points: parsed.keyPoints ?? [],
        source_type: images.length > 1 ? "pdf" : "image",
        processing_state: "done",
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // Upload images to Supabase Storage
    const imageRows = [];
    for (let i = 0; i < images.length; i++) {
      const dataUrl = images[i];
      const comma = dataUrl.indexOf(",");
      const base64 = dataUrl.slice(comma + 1);
      const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const path = `${user.id}/${note.id}/${i}.jpg`;

      await admin.storage.from("note-images").upload(path, binary, {
        contentType: "image/jpeg",
        upsert: true,
      });

      imageRows.push({
        note_id: note.id,
        user_id: user.id,
        storage_path: path,
        page_number: i,
      });
    }

    if (imageRows.length) {
      await admin.from("note_images").insert(imageRows);
    }

    return json({ ok: true, note }, 200);
  } catch (err) {
    console.error("[process-note]", err);
    return json({ error: String(err) }, 500);
  }
});

// ── helpers ────────────────────────────────────────────────────

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function parseJSON(text: string) {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in AI response");
  return JSON.parse(match[0]);
}

async function getUserFromAccessToken(supabaseUrl: string, supabaseAnonKey: string, accessToken: string) {
  if (!accessToken) return null;

  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) return null;
  return await res.json();
}

function resolveAnthropicModel(model?: string | null) {
  switch (model) {
    case "claude-opus-4-6":
      return "claude-opus-4-20250514";
    case "claude-haiku-4-5-20251001":
      return "claude-haiku-4-5-20251001";
    case "claude-sonnet-4-6":
    default:
      return "claude-sonnet-4-20250514";
  }
}
