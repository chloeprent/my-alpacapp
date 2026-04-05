-- Enforce payment method display order: Zelle & Venmo first, Cash App next, card/online last
UPDATE payment_methods SET display_order = 1 WHERE method_type = 'zelle';
UPDATE payment_methods SET display_order = 2 WHERE method_type = 'venmo';
UPDATE payment_methods SET display_order = 3 WHERE method_type = 'cashapp';
UPDATE payment_methods SET display_order = 4 WHERE method_type = 'paypal';
UPDATE payment_methods SET display_order = 5 WHERE method_type = 'cash';
UPDATE payment_methods SET display_order = 6 WHERE method_type = 'check';
UPDATE payment_methods SET display_order = 10 WHERE method_type = 'bank_ach';
UPDATE payment_methods SET display_order = 11 WHERE method_type = 'stripe';
UPDATE payment_methods SET display_order = 12 WHERE method_type = 'square';
