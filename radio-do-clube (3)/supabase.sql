-- Rode no Supabase: SQL Editor > New query > Run

create table if not exists playlist (
  id uuid primary key default gen_random_uuid(),
  position int not null,
  kind text not null check (kind in ('youtube','spotify','file')),
  ref text, src text, link text, cover text,
  title text not null default 'Sem título',
  artist text not null default '',
  created_at timestamptz default now()
);

create table if not exists radio_state (
  id int primary key check (id = 1),
  current_id uuid references playlist(id) on delete set null,
  playing boolean not null default false,
  started_at timestamptz not null default now()
);
insert into radio_state (id) values (1) on conflict do nothing;

-- Leitura pública; escrita só para o admin logado
alter table playlist enable row level security;
alter table radio_state enable row level security;
create policy "ler playlist" on playlist for select to anon, authenticated using (true);
create policy "ler estado"   on radio_state for select to anon, authenticated using (true);
create policy "admin escreve playlist" on playlist for all to authenticated using (true) with check (true);
-- radio_state NÃO tem policy de escrita: só muda pelas funções abaixo.

-- Hora do servidor (evita erro por relógio errado no celular do ouvinte)
create or replace function server_time() returns timestamptz
language sql stable as $$ select now() $$;
grant execute on function server_time() to anon, authenticated;

-- Admin: tocar uma faixa / parar
create or replace function radio_go(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'não autorizado'; end if;
  update radio_state set current_id = p_id, playing = true, started_at = now() where id = 1;
end $$;
create or replace function radio_stop() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'não autorizado'; end if;
  update radio_state set playing = false where id = 1;
end $$;
revoke all on function radio_go(uuid), radio_stop() from public, anon;
grant execute on function radio_go(uuid), radio_stop() to authenticated;

-- Ouvintes: "a faixa acabou". Só avança se for a faixa atual e já passaram 3s (várias chamadas simultâneas = 1 avanço)
create or replace function advance(expected uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s radio_state; nxt uuid; pos_ int;
begin
  select * into s from radio_state where id = 1 for update;
  if not s.playing or s.current_id is distinct from expected or now() - s.started_at < interval '3 seconds' then return; end if;
  select position into pos_ from playlist where id = s.current_id;
  select id into nxt from playlist where position > coalesce(pos_, -1) order by position limit 1;
  if nxt is null then select id into nxt from playlist order by position limit 1; end if;
  if nxt is null then update radio_state set playing = false where id = 1; return; end if;
  update radio_state set current_id = nxt, started_at = now() where id = 1;
end $$;
grant execute on function advance(uuid) to anon, authenticated;

-- Tempo real
alter publication supabase_realtime add table playlist, radio_state;

-- Armazenamento dos arquivos enviados
insert into storage.buckets (id, name, public) values ('radio', 'radio', true) on conflict do nothing;
create policy "admin envia audio"  on storage.objects for insert to authenticated with check (bucket_id = 'radio');
create policy "admin apaga audio"  on storage.objects for delete to authenticated using (bucket_id = 'radio');
-- (leitura é pública porque o bucket é público)

-- Permissões básicas das tabelas (corrige "permission denied for table playlist")
grant usage on schema public to anon, authenticated;
grant select on playlist, radio_state to anon, authenticated;
grant insert, update, delete on playlist to authenticated;
