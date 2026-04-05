-- Save PayPal sandbox credentials and enable test mode for initial testing
UPDATE paypal_config SET
  sandbox_client_id = 'ATueJgaBjw4rJoOfvB1hbDGQ58ECST5osyiftO-B81pYqI_reX-gxh3zgr4XYUgPUQLNSv2T0tOpdrwq',
  sandbox_client_secret = 'ECtdQ0HnyHOVekI-598MwHDQJeiKBTAmosKaqWlCTji2R9xQuzsrvcKpheYfvg7umtHxuIA53IAz-qJh',
  test_mode = true,
  is_active = true,
  updated_at = now()
WHERE id = 1;
