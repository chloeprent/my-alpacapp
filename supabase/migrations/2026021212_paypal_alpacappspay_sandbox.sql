-- Save AlpacAppsPay sandbox credentials (Merchant type app)
UPDATE paypal_config SET
  sandbox_client_id = 'AWWEekmOcpfVoypOACdRbNIwZMROPPjw_pAgU-GxZAszMMKwdScRwpmXLYMOF6YW2PNFT7N2ugBcKQTG',
  sandbox_client_secret = 'EDRtBcqCOBdZMrtBr5voMST7Kj6aVO_xmqWmKXkeXWt4Sc1559cI79WR7vn2czmQuSAmuKmRfHvafZ9N',
  test_mode = true,
  is_active = true,
  updated_at = now()
WHERE id = 1;
