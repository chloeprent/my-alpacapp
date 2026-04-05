-- Add support@ forwarding rule so support@alpacaplayhouse.com goes to the team inbox
INSERT INTO email_forwarding_config (address_prefix, forward_to, is_active)
VALUES ('support', 'alpacaplayhouse@gmail.com', true)
ON CONFLICT DO NOTHING;
