SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS as_of,
CAST(COALESCE(MAX(id), 0) AS CHAR) AS high_water
FROM financial.payment_channel_trade_event_record
