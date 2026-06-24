-- ═══════════════════════════════════════════════════════════════════════
-- Livraisanté — push_subscriptions table
-- Stocke les abonnements Web Push par utilisateur
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz DEFAULT now(),
  UNIQUE(user_id, endpoint)
);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Un utilisateur ne voit et ne modifie que ses propres abonnements
CREATE POLICY "push_own"
  ON push_subscriptions FOR ALL USING (user_id = auth.uid());

-- Index pour requêtes par user_id (envoi de notifs)
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
