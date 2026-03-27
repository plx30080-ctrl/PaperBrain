UPDATE profiles
SET model = CASE model
  WHEN 'claude-sonnet-4-6' THEN 'claude-sonnet-4-20250514'
  WHEN 'claude-opus-4-6' THEN 'claude-opus-4-20250514'
  ELSE model
END
WHERE model IN ('claude-sonnet-4-6', 'claude-opus-4-6');

ALTER TABLE profiles
ALTER COLUMN model SET DEFAULT 'claude-sonnet-4-20250514';