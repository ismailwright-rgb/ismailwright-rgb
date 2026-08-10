-- ============================================================================
-- Migration 024 - one call that hands the angle engine everything it knows
--
-- The angle engine needs four things before it can decide what today is about:
-- the brand brain, the long-term memory, what was written recently, and which
-- formats are under-fed this week. That is four separate PostgREST reads.
--
-- Four reads is a problem in n8n specifically. A JSON array response is split
-- into ONE ITEM PER ELEMENT, so a node that reads 15 brain rows emits 15 items,
-- and the next read node then runs 15 times. Chaining the reads means either
-- fifteen duplicate queries or a collapse node after every one of them. (V1 hit
-- the item-splitting behaviour already, in the other direction: $input.first()
-- silently returned the first row rather than the array.)
--
-- One function returning one jsonb object sidesteps all of it: one request, one
-- item, no splitting, and the shape is defined here in SQL where it can be
-- tested rather than assembled by hand in a Code node.
--
-- Safe to run more than once.
-- ============================================================================

create or replace function public.content_studio_context(_days int default 14)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select jsonb_build_object(

    -- The whole LinkedIn brief. Not vertical-filtered on purpose: the angle
    -- engine picks which audiences the day's three drafts speak to, so it needs
    -- to see all five ICPs to choose between them.
    'brain', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', b.kind, 'title', b.title,
               'content', b.content, 'vertical', b.vertical)
             order by b.kind)
      from public.brand_brain b
      where b.channel = 'linkedin'
        and b.status in ('proven', 'testing')
    ), '[]'::jsonb),

    -- Everything the studio has learned. This is what stops draft 40 from
    -- re-running draft 3.
    'memory', coalesce((
      select jsonb_agg(jsonb_build_object(
               'category', m.category, 'key', m.key, 'value', m.value)
             order by m.category, m.key)
      from public.content_memory m
    ), '[]'::jsonb),

    -- Recent output, newest first. The angle engine is told to avoid these
    -- theses specifically - the equivalent of Sydney reading her last 7 days so
    -- today feels different.
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'content_type', q.content_type, 'vertical', q.target_vertical,
               'bottleneck', q.bottleneck, 'thesis', q.thesis,
               'title', q.title, 'status', q.status,
               'day', q.created_at::date)
             order by q.created_at desc)
      from (
        select * from public.content_queue
        where created_at > now() - make_interval(days => _days)
        order by created_at desc
        limit 40
      ) q
    ), '[]'::jsonb),

    -- Which formats are under-fed. At three drafts a day the mix drifts fast,
    -- and a week of nothing but text posts is the failure mode. Handing the
    -- engine the actual counts beats hardcoding a rotation it cannot see.
    'format_counts', coalesce((
      select jsonb_object_agg(t.content_type, t.n)
      from (
        select content_type::text as content_type, count(*) as n
        from public.content_queue
        where created_at > now() - interval '7 days'
        group by 1
      ) t
    ), '{}'::jsonb),

    -- Published, not just generated. What Ismail actually approved is the only
    -- real signal of what he thinks is good.
    'approved_recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'content_type', q.content_type, 'thesis', q.thesis,
               'bottleneck', q.bottleneck)
             order by q.created_at desc)
      from (
        select * from public.content_queue
        where status in ('approved', 'posted')
        order by created_at desc
        limit 15
      ) q
    ), '[]'::jsonb)
  );
$$;

comment on function public.content_studio_context(int) is
  'Everything the angle engine needs, as one jsonb object. One call instead of four, because n8n splits array responses into separate items and chaining the reads would re-run each one per row.';

-- security definer so the studio reads consistently regardless of caller, but
-- it must not be reachable without a key.
revoke execute on function public.content_studio_context(int) from public, anon;
grant execute on function public.content_studio_context(int) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select jsonb_pretty(public.content_studio_context(14));
--   select jsonb_array_length(public.content_studio_context(14) -> 'brain');   -- 15
--   select public.content_studio_context(14) -> 'format_counts';
