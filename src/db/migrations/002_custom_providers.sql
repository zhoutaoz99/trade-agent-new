alter table config
  add column if not exists custom_providers jsonb not null default
    '[
      {"provider":"poe","models":[],"baseUrl":"https://api.poe.com/v1"},
      {"provider":"deepseek","models":["deepseek-chat"],"baseUrl":"https://api.deepseek.com"}
    ]'::jsonb;
