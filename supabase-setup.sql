-- =====================================================================
-- Moe Wiggly Studio · modo online · configuración de Supabase
-- Ejecutar UNA vez en: Supabase Dashboard > SQL Editor > New query > Run
-- (antes: Authentication > Sign In / Providers > activar "Allow anonymous sign-ins")
-- Es seguro volver a ejecutarlo (usa "if not exists" / "or replace").
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- tablas ----------
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (char_length(name) between 1 and 60),
  max_players int not null check (max_players between 2 and 5),   -- tope absoluto: 5
  host_id uuid not null,                                         -- solo lo escribe el servidor
  has_password boolean not null default false,
  closed boolean not null default false,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
-- el hash de la contraseña vive aparte: ningún cliente puede leerlo (RLS sin políticas)
create table if not exists public.room_secrets (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  pass_hash text not null
);
create table if not exists public.room_stats (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  ops int not null default 0
);
create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  name text not null check (char_length(name) between 1 and 24),
  color text not null,
  layer text,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (room_id, user_id)
);
create table if not exists public.room_ops (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  k text not null check (k in ('M','meta','s','d','la','lu','lo','lx')),
  p jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists room_ops_room_id_idx on public.room_ops (room_id, id);

-- NUEVO: contraseña visible solo para el anfitrión (RLS sin políticas: ningún cliente la lee directamente;
-- solo la devuelve get_room_password() y únicamente al anfitrión) y marca de "expulsado" (no permanente).
alter table public.room_secrets add column if not exists pass_plain text;
alter table public.room_members add column if not exists kicked boolean not null default false;

-- ---------- RLS: los clientes SOLO pueden leer lo de sus salas; todo se escribe vía RPC ----------
alter table public.rooms         enable row level security;
alter table public.room_secrets  enable row level security;
alter table public.room_stats    enable row level security;
alter table public.room_members  enable row level security;
alter table public.room_ops      enable row level security;

revoke all on public.rooms, public.room_secrets, public.room_stats, public.room_members, public.room_ops from anon, authenticated;
grant select on public.rooms, public.room_members, public.room_ops to authenticated;

create or replace function public.is_room_member(p_room uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.room_members m
                 where m.room_id = p_room and m.user_id = (select auth.uid()) and not m.kicked);
$$;

drop policy if exists rooms_select on public.rooms;
drop policy if exists members_select on public.room_members;
drop policy if exists ops_select on public.room_ops;
create policy rooms_select   on public.rooms        for select to authenticated using (public.is_room_member(id));
create policy members_select on public.room_members for select to authenticated using (public.is_room_member(room_id));
create policy ops_select     on public.room_ops     for select to authenticated using (public.is_room_member(room_id));
-- (no existen políticas de insert/update/delete: un cliente no puede escribir nada directamente)

-- ---------- Realtime: canales PRIVADOS, solo miembros de la sala ----------
-- Tema del canal = 'room:<uuid>'. Sin estas políticas nadie puede enviar ni recibir en canales privados.
create or replace function public.topic_room_id() returns uuid
language plpgsql stable set search_path = '' as $$
declare t text := (select realtime.topic());
begin
  if t ~ '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return substr(t, 6)::uuid;
  end if;
  return null;
end $$;

drop policy if exists "moe room members receive" on realtime.messages;
drop policy if exists "moe room members send" on realtime.messages;
create policy "moe room members receive" on realtime.messages for select to authenticated
  using (realtime.messages.extension in ('broadcast','presence') and public.is_room_member(public.topic_room_id()));
create policy "moe room members send" on realtime.messages for insert to authenticated
  with check (realtime.messages.extension in ('broadcast','presence') and public.is_room_member(public.topic_room_id()));

-- tablas que emiten cambios (postgres_changes; siguen respetando RLS)
do $$ begin alter publication supabase_realtime add table public.rooms;    exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.room_ops; exception when duplicate_object then null; end $$;

-- ---------- utilidades internas (no accesibles para clientes) ----------
create or replace function public._palette() returns text[] language sql immutable set search_path = '' as
$$ select array['#ff3b30','#0a84ff','#34c759','#ff9500','#af52de'] $$;

create or replace function public._active_window() returns interval language sql immutable set search_path = '' as
$$ select interval '90 seconds' $$;   -- un miembro sin latido durante 90 s deja de ocupar plaza

create or replace function public._clean_name(p text) returns text language sql immutable set search_path = '' as
$$ select coalesce(nullif(left(btrim(regexp_replace(coalesce(p,''), '\s+', ' ', 'g')), 24), ''), 'Invitado') $$;

-- cierra una sala y borra al instante lo pesado (dibujo, contraseña, contadores). La fila de la sala y sus miembros
-- se quedan 5 minutos solo para que los clientes se enteren de que está cerrada; después _cleanup() las borra.
create or replace function public._close_room(p_room uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.rooms set closed = true, closed_at = now() where id = p_room and not closed;
  delete from public.room_ops     where room_id = p_room;
  delete from public.room_secrets where room_id = p_room;
  delete from public.room_stats   where room_id = p_room;
end $$;

-- limpieza total (la ejecuta pg_cron cada minuto, ver el final del archivo; también se llama al crear salas):
--  1) sala abierta cuyo anfitrión lleva más de 10 min sin dar señales → se cierra y se borra su dibujo
--  2) sala cerrada hace más de 5 min → se borra por completo (miembros incluidos)
--  3) usuarios anónimos de Supabase sin ninguna sala y sin actividad en 1 día → se borran
create or replace function public._cleanup() returns void
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  for v in select r.id from public.rooms r
            where not r.closed
              and coalesce((select max(m.last_seen) from public.room_members m
                             where m.room_id = r.id and m.user_id = r.host_id), r.created_at) < now() - interval '10 minutes'
  loop
    perform public._close_room(v);
  end loop;
  delete from public.rooms where closed and closed_at < now() - interval '5 minutes';
  begin
    delete from auth.users u
     where u.is_anonymous
       and coalesce(u.last_sign_in_at, u.created_at) < now() - interval '1 day'
       and not exists (select 1 from public.room_members m where m.user_id = u.id)
       and not exists (select 1 from auth.refresh_tokens t
                        where t.user_id::text = u.id::text and t.updated_at > now() - interval '1 day');
  exception when others then null;   -- si esta versión de Supabase difiere, la limpieza de salas sigue funcionando
  end;
end $$;

-- ---------- RPC: crear sala ----------
create or replace function public.create_room(p_name text, p_pass text, p_max int, p_user_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  v_name text := left(btrim(coalesce(p_name,'')), 60);
  v_id uuid; v_code text; b bytea; i int;
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- 32 símbolos, sin O/0/I/1
  v_color text := (public._palette())[1];
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if v_name = '' then raise exception 'bad_name'; end if;
  if p_max is null or p_max < 2 or p_max > 5 then raise exception 'bad_max'; end if;
  if p_pass is not null and char_length(p_pass) > 72 then raise exception 'bad_password_format'; end if;
  perform public._cleanup();
  if (select count(*) from public.rooms where host_id = uid and not closed) >= 3 then
    raise exception 'too_many_rooms';
  end if;
  loop
    b := extensions.gen_random_bytes(8); v_code := '';
    for i in 0..7 loop v_code := v_code || substr(alphabet, (get_byte(b, i) % 32) + 1, 1); end loop;
    begin
      insert into public.rooms(code, name, max_players, host_id, has_password)
      values (v_code, v_name, p_max, uid, coalesce(p_pass,'') <> '') returning id into v_id;
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  if coalesce(p_pass,'') <> '' then
    insert into public.room_secrets(room_id, pass_hash, pass_plain)
    values (v_id, extensions.crypt(p_pass, extensions.gen_salt('bf', 8)), p_pass);
  end if;
  insert into public.room_stats(room_id) values (v_id);
  insert into public.room_members(room_id, user_id, name, color) values (v_id, uid, public._clean_name(p_user_name), v_color);
  return jsonb_build_object('room_id', v_id, 'code', v_code, 'name', v_name, 'max_players', p_max, 'host_id', uid, 'color', v_color);
end $$;

-- ---------- RPC: unirse (aquí se impone el límite de 5, con bloqueo de fila) ----------
create or replace function public.join_room(p_code text, p_pass text, p_user_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  r public.rooms; v_hash text; v_exists boolean; v_active int; v_own text; v_color text; v_kicked boolean;
  v_used text[];
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  -- FOR UPDATE: serializa las entradas simultáneas a la MISMA sala. La segunda espera a que
  -- termine la primera y ya ve su plaza ocupada, así que no se puede superar el límite.
  select * into r from public.rooms where code = upper(btrim(coalesce(p_code,''))) for update;
  if not found then raise exception 'room_not_found'; end if;
  if r.closed then raise exception 'room_closed'; end if;

  select color, kicked into v_own, v_kicked from public.room_members where room_id = r.id and user_id = uid;
  v_exists := found and not coalesce(v_kicked, false);   -- un expulsado que vuelve debe poner la contraseña otra vez
  if not v_exists and r.has_password then
    select pass_hash into v_hash from public.room_secrets where room_id = r.id;
    if coalesce(p_pass,'') = '' or v_hash is null or extensions.crypt(p_pass, v_hash) <> v_hash then
      raise exception 'bad_password';
    end if;
  end if;

  select count(*), coalesce(array_agg(color), '{}') into v_active, v_used
    from public.room_members
   where room_id = r.id and user_id <> uid and not kicked
     and (last_seen > now() - public._active_window() or user_id = r.host_id);   -- la plaza del anfitrión siempre cuenta
  if v_active >= least(r.max_players, 5) then raise exception 'room_full'; end if;

  if v_own is not null and not (v_own = any(v_used)) then v_color := v_own;
  else
    select c into v_color from unnest(public._palette()) with ordinality t(c, n)
     where not (c = any(v_used)) order by n limit 1;
  end if;

  insert into public.room_members(room_id, user_id, name, color, last_seen)
  values (r.id, uid, public._clean_name(p_user_name), v_color, now())
  on conflict (room_id, user_id) do update
    set name = excluded.name, color = excluded.color, last_seen = now(), kicked = false;
  return jsonb_build_object('room_id', r.id, 'code', r.code, 'name', r.name,
                            'max_players', r.max_players, 'host_id', r.host_id, 'color', v_color);
end $$;

-- ---------- RPC: latido (renueva plaza, nombre y capa; devuelve la lista de participantes) ----------
create or replace function public.heartbeat(p_room uuid, p_name text, p_layer text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  r public.rooms; m public.room_members; v_active int; v_host_seen timestamptz;
begin
  select * into r from public.rooms where id = p_room for update;
  if not found then raise exception 'room_not_found'; end if;
  select * into m from public.room_members where room_id = p_room and user_id = uid;
  if not found then raise exception 'not_member'; end if;
  if m.kicked then   -- el anfitrión lo expulsó
    return jsonb_build_object('kicked', false, 'removed', true, 'closed', r.closed, 'members', '[]'::jsonb);
  end if;

  if not r.closed then
    -- si estuvo desconectado más de 90 s, su plaza pudo ocuparla otra persona: se revalida el límite
    if uid <> r.host_id and m.last_seen < now() - public._active_window() then   -- el anfitrión nunca pierde su plaza
      select count(*) into v_active from public.room_members
       where room_id = p_room and user_id <> uid and not kicked and last_seen > now() - public._active_window();
      if v_active >= least(r.max_players, 5) then
        delete from public.room_members where room_id = p_room and user_id = uid;
        return jsonb_build_object('kicked', true, 'closed', false, 'members', '[]'::jsonb);
      end if;
    end if;
    -- anfitrión desaparecido más de 10 min (sin latidos): se cierra la sala; una caída breve NO la cierra
    if uid <> r.host_id then
      select max(last_seen) into v_host_seen from public.room_members where room_id = p_room and user_id = r.host_id;
      if coalesce(v_host_seen, r.created_at) < now() - interval '10 minutes' then
        perform public._close_room(p_room);
        r.closed := true;
      end if;
    end if;
  end if;

  if not r.closed then
    update public.room_members set last_seen = now(), name = public._clean_name(p_name), layer = left(p_layer, 40)
     where room_id = p_room and user_id = uid;
  end if;

  return jsonb_build_object('kicked', false, 'closed', r.closed, 'members', coalesce((
    select jsonb_agg(jsonb_build_object('u', user_id, 'name', name, 'color', color, 'layer', layer,
                                        'host', user_id = r.host_id) order by joined_at)
      from public.room_members
     where room_id = p_room and not kicked and last_seen > now() - public._active_window()), '[]'::jsonb));
end $$;

-- ---------- RPC: abandonar / cerrar ----------
create or replace function public.leave_room(p_room uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); v_host uuid;
begin
  select host_id into v_host from public.rooms where id = p_room;
  if v_host = uid then   -- el anfitrión libera su plaza pero puede volver (la sala caduca a los 10 min sin él)
    update public.room_members set last_seen = now() - interval '91 seconds' where room_id = p_room and user_id = uid;
  else
    delete from public.room_members where room_id = p_room and user_id = uid;
  end if;
end $$;

create or replace function public.close_room(p_room uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if not exists (select 1 from public.rooms where id = p_room and host_id = uid and not closed) then
    raise exception 'host_only';
  end if;
  perform public._close_room(p_room);
end $$;

-- ---------- RPC: expulsar (solo anfitrión; NO es permanente: la persona puede volver con el código y la contraseña) ----------
create or replace function public.kick_member(p_room uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if not exists (select 1 from public.rooms where id = p_room and host_id = uid and not closed) then
    raise exception 'host_only';
  end if;
  if p_user = uid then raise exception 'cannot_kick_self'; end if;
  update public.room_members set kicked = true, last_seen = now() - interval '91 seconds'   -- libera su plaza al instante
   where room_id = p_room and user_id = p_user;
end $$;

-- ---------- RPC: contraseña de la sala (solo la ve el anfitrión) ----------
create or replace function public.get_room_password(p_room uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if not exists (select 1 from public.rooms where id = p_room and host_id = uid) then
    raise exception 'host_only';
  end if;
  return (select pass_plain from public.room_secrets where room_id = p_room);
end $$;

-- ---------- RPC: enviar operaciones de dibujo (persistentes) ----------
create or replace function public.push_ops(p_room uuid, p_ops jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  r public.rooms; o jsonb; v_k text; v_p jsonb; n int;
begin
  select * into r from public.rooms where id = p_room for update;   -- orden de ids = orden de commit
  if not found then raise exception 'room_not_found'; end if;
  if r.closed then raise exception 'room_closed'; end if;
  if not exists (select 1 from public.room_members where room_id = p_room and user_id = uid and not kicked) then
    raise exception 'not_member';
  end if;
  if jsonb_typeof(p_ops) is distinct from 'array' or jsonb_array_length(p_ops) > 200 then raise exception 'bad_ops'; end if;
  n := jsonb_array_length(p_ops);
  update public.room_stats set ops = ops + n where room_id = p_room and ops + n <= 40000;
  if not found then raise exception 'room_ops_limit'; end if;

  for o in select * from jsonb_array_elements(p_ops) loop
    v_k := o->>'k'; v_p := o->'p';
    if v_k is null or v_k not in ('M','meta','s','d','la','lu','lo','lx') then raise exception 'bad_ops'; end if;
    if jsonb_typeof(v_p) is distinct from 'object' then raise exception 'bad_ops'; end if;
    if octet_length(v_p::text) > 262144 then raise exception 'op_too_large'; end if;
    if v_k = 'M' and uid <> r.host_id then raise exception 'host_only'; end if;   -- solo el anfitrión inicializa
    if v_k = 's' then
      if jsonb_typeof(v_p->'pts') is distinct from 'array' or jsonb_typeof(v_p->'i') is distinct from 'string' then raise exception 'bad_ops'; end if;
      v_p := jsonb_set(v_p, '{u}', to_jsonb(uid::text));   -- el autor lo fija el servidor, no el cliente
    end if;
    insert into public.room_ops(room_id, user_id, k, p) values (p_room, uid, v_k, v_p);
  end loop;
  return n;
end $$;

-- ---------- permisos de ejecución ----------
revoke all on function public.create_room(text,text,int,text), public.join_room(text,text,text),
  public.heartbeat(uuid,text,text), public.leave_room(uuid), public.close_room(uuid),
  public.push_ops(uuid,jsonb), public._cleanup(), public._close_room(uuid), public.is_room_member(uuid), public.topic_room_id(),
  public.kick_member(uuid,uuid), public.get_room_password(uuid)
  from public, anon;
revoke all on function public._cleanup(), public._close_room(uuid) from authenticated;   -- interna: solo la usan otras funciones
grant execute on function public.create_room(text,text,int,text), public.join_room(text,text,text),
  public.heartbeat(uuid,text,text), public.leave_room(uuid), public.close_room(uuid),
  public.push_ops(uuid,jsonb), public.is_room_member(uuid), public.topic_room_id(),
  public.kick_member(uuid,uuid), public.get_room_password(uuid) to authenticated;

-- ---------- limpieza automática cada minuto con pg_cron ----------
-- Es lo que borra las salas cuando no queda nadie (sin esto solo se limpiaría al crear salas nuevas).
-- Si al ejecutar sale el aviso "pg_cron no está activo", actívalo en Dashboard > Database > Extensions > pg_cron
-- y vuelve a ejecutar SOLO este bloque.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('moe-wiggly-cleanup', '* * * * *', 'select public._cleanup()');
exception when others then
  raise notice 'pg_cron no está activo (%). Actívalo en Database > Extensions > pg_cron y vuelve a ejecutar este bloque.', sqlerrm;
end $$;
