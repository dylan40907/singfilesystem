import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Called by the `notification_push` DB trigger (pg_net) whenever a row is added
// to public.hr_notifications. Looks up the recipient's Expo push tokens and
// dispatches a native push via Expo's push service. Guarded by a shared secret
// (the trigger sends it in the x-push-secret header) since verify_jwt is off.

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
// Fallback keeps it working out-of-the-box for testing; override in prod with
//   supabase secrets set PUSH_HOOK_SECRET=...
const SECRET = Deno.env.get("PUSH_HOOK_SECRET") ?? "hrpush_3f9c1e7a4b2d8056e1a9f4c7b0d2e6a8";

Deno.serve(async (req) => {
  try {
    if (req.headers.get("x-push-secret") !== SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    const { notification_id } = await req.json().catch(() => ({}));
    if (!notification_id) return json({ error: "missing notification_id" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: notif } = await supabase
      .from("hr_notifications")
      .select("id, user_id, type, title, body, data")
      .eq("id", notification_id)
      .maybeSingle();
    if (!notif) return json({ error: "notification not found" }, 404);

    const { data: tokens } = await supabase
      .from("user_push_tokens")
      .select("token")
      .eq("user_id", notif.user_id);

    if (!tokens || tokens.length === 0) return json({ sent: 0, reason: "no tokens" });

    // The home-screen badge. iOS only shows a number the payload gives it, and
    // the app may not be running to set one itself, so the count has to come
    // from here. Every unread row counts — chat messages included, since those
    // are notifications too.
    const { count } = await supabase
      .from("hr_notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", notif.user_id)
      .is("read_at", null);
    const badge = count ?? 0;

    const messages = tokens.map((t: { token: string }) => ({
      to: t.token,
      sound: "default",
      title: notif.title,
      body: notif.body,
      badge,
      data: { ...(notif.data ?? {}), type: notif.type, notification_id: notif.id },
      channelId: "default",
    }));

    const resp = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
    });
    const result = await resp.json().catch(() => null);

    // Prune tokens Expo reports as dead so we stop pushing to them.
    const rows = Array.isArray(result?.data) ? result.data : [];
    const dead: string[] = [];
    rows.forEach((r: any, i: number) => {
      if (r?.status === "error" && r?.details?.error === "DeviceNotRegistered") {
        dead.push(messages[i].to);
      }
    });
    if (dead.length) await supabase.from("user_push_tokens").delete().in("token", dead);

    return json({ sent: messages.length, badge, result });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
