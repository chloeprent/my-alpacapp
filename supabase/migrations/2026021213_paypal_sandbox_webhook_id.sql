-- Save sandbox webhook ID from PayPal developer dashboard
UPDATE paypal_config SET
  sandbox_webhook_id = '7P496305N9804370S',
  updated_at = now()
WHERE id = 1;
