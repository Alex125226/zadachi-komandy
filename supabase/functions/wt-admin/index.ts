import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const DOMAIN = "zadachi.app";
const cleanLogin = (l: unknown) => String(l ?? "").trim().toLowerCase();
const okLogin = (l: string) => /^[a-z0-9._-]{3,32}$/.test(l);
const okPass = (p: unknown) => typeof p === "string" && p.length >= 6 && p.length <= 72;
const cleanName = (n: unknown) => String(n ?? "").trim().slice(0, 60);
const LOGIN_ERR = "Логин: 3–32 латинские буквы, цифры, точка, дефис";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Неверный запрос" }, 400); }
  const action = String(body.action ?? "");

  const { data: adminRoles, error: rErr } = await admin.from("wt_roles").select("key").eq("is_admin", true);
  if (rErr) return json({ error: "Ошибка базы" }, 500);
  const adminKeys = (adminRoles ?? []).map((r) => r.key as string);
  const { count: mgrCount, error: cErr } = await admin.from("wt_members").select("user_id", { count: "exact", head: true }).eq("active", true).in("role", adminKeys.length ? adminKeys : ["manager"]);
  if (cErr) return json({ error: "Ошибка базы" }, 500);

  if (action === "status") return json({ needsSetup: (mgrCount ?? 0) === 0, domain: DOMAIN });

  const createUser = async (login: string, password: string, name: string, role: string, regions: string[]) => {
    const { data, error } = await admin.auth.admin.createUser({ email: `${login}@${DOMAIN}`, password, email_confirm: true, user_metadata: { name } });
    if (error || !data.user) {
      const msg = /already|registered|exists/i.test(error?.message ?? "") ? "Такой логин уже занят" : "Не удалось создать пользователя";
      return { error: msg };
    }
    const { error: mErr } = await admin.from("wt_members").insert({ user_id: data.user.id, name, login, role, regions });
    if (mErr) { await admin.auth.admin.deleteUser(data.user.id); return { error: "Не удалось сохранить сотрудника" }; }
    return { user_id: data.user.id };
  };

  if (action === "bootstrap") {
    if ((mgrCount ?? 0) > 0) return json({ error: "Руководитель уже создан" }, 403);
    const login = cleanLogin(body.login), name = cleanName(body.name);
    if (!okLogin(login)) return json({ error: LOGIN_ERR }, 400);
    if (!okPass(body.password)) return json({ error: "Пароль: от 6 символов" }, 400);
    if (!name) return json({ error: "Укажите имя" }, 400);
    const r = await createUser(login, body.password as string, name, "manager", []);
    return json(r, r.error ? 400 : 200);
  }

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Нужен вход" }, 401);
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !u.user) return json({ error: "Нужен вход" }, 401);
  const { data: me } = await admin.from("wt_members").select("role,active,regions").eq("user_id", u.user.id).maybeSingle();
  if (!me || !me.active || !adminKeys.includes(me.role)) return json({ error: "Только для руководителя" }, 403);

  if (action === "create") {
    const login = cleanLogin(body.login), name = cleanName(body.name);
    const role = String(body.role ?? "staff");
    const { data: roleRow } = await admin.from("wt_roles").select("key").eq("key", role).maybeSingle();
    if (!roleRow) return json({ error: "Такой роли нет" }, 400);
    const mine: string[] = me.regions ?? [];
    let regions = (Array.isArray(body.regions) ? body.regions : (body.region ? [body.region] : [])).map((x) => String(x).slice(0, 40)).filter(Boolean);
    if (mine.length) { regions = regions.filter((r) => mine.includes(r)); if (!regions.length) regions = mine; }
    if (!okLogin(login)) return json({ error: LOGIN_ERR }, 400);
    if (!okPass(body.password)) return json({ error: "Пароль: от 6 символов" }, 400);
    if (!name) return json({ error: "Укажите имя" }, 400);
    const r = await createUser(login, body.password as string, name, role, regions);
    return json(r, r.error ? 400 : 200);
  }

  const uid = String(body.user_id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(uid)) return json({ error: "Неверный сотрудник" }, 400);
  const { data: target } = await admin.from("wt_members").select("user_id,regions").eq("user_id", uid).maybeSingle();
  if (!target) return json({ error: "Сотрудник не найден" }, 404);
  const myRegs: string[] = me.regions ?? [], tRegs: string[] = target.regions ?? [];
  if (myRegs.length && (!tRegs.length || !tRegs.every((r) => myRegs.includes(r)))) return json({ error: "Этот сотрудник не из ваших регионов" }, 403);

  if (action === "delete") {
    if (uid === u.user.id) return json({ error: "Нельзя удалить себя" }, 400);
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error) return json({ error: /руководител/i.test(error.message) ? "В команде должен остаться хотя бы один руководитель" : "Не удалось удалить сотрудника" }, 400);
    return json({ ok: true });
  }

  if (action === "reset") {
    if (!okPass(body.password)) return json({ error: "Пароль: от 6 символов" }, 400);
    const { error } = await admin.auth.admin.updateUserById(uid, { password: body.password as string });
    return error ? json({ error: "Не удалось сменить пароль" }, 400) : json({ ok: true });
  }
  if (action === "block" || action === "unblock") {
    if (uid === u.user.id) return json({ error: "Нельзя заблокировать себя" }, 400);
    const on = action === "unblock";
    if (!on) {
      const { error: bErr } = await admin.from("wt_members").update({ active: false }).eq("user_id", uid);
      if (bErr) return json({ error: /руководител/i.test(bErr.message) ? "В команде должен остаться хотя бы один руководитель" : "Не удалось изменить доступ" }, 400);
    }
    const { error } = await admin.auth.admin.updateUserById(uid, { ban_duration: on ? "none" : "876000h" });
    if (error) return json({ error: "Не удалось изменить доступ" }, 400);
    if (on) await admin.from("wt_members").update({ active: true }).eq("user_id", uid);
    return json({ ok: true });
  }
  return json({ error: "Неизвестное действие" }, 400);
});
