SELECT CAST(e.id AS CHAR) AS event_record_id,
CAST(e.order_id AS CHAR) AS application_id,
e.country_code,
DATE_FORMAT(e.create_time, '%Y-%m-%d %H:%i:%s') AS create_time,
COALESCE(c.channel_name, e.channel_code) AS channel_name,
e.proxy_id AS channel_id,
e.channel_code
FROM financial.payment_channel_trade_event_record e
LEFT JOIN financial.payment_channel c ON c.channel_code = e.channel_code
WHERE e.business_type = 'PAYOUT'
AND e.event_type = 'CALL'
AND e.event_result = 'SUCCESS'
AND e.callback_received = 0
AND e.del_flag = 0
AND e.create_time >= NOW() - INTERVAL 1 MONTH
AND e.create_time < NOW() - INTERVAL 6 HOUR
AND e.id > 0
ORDER BY e.id
LIMIT 100
