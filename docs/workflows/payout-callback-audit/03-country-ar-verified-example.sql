SELECT CAST(l.application_id AS CHAR) AS application_id,
CAST(l.id AS CHAR) AS loan_order_id,
CAST(p.id AS CHAR) AS payment_record_id,
p.proxy_id AS channel_id,
p.status AS payment_status,
l.payment_code AS channel_order_no,
DATE_FORMAT(a.application_time, '%Y-%m-%d %H:%i:%s') AS application_time,
DATE_FORMAT(p.create_time, '%Y-%m-%d %H:%i:%s') AS payment_create_time
FROM ar.loan_order_info l
JOIN ar.payment_record p ON p.order_id = l.id
LEFT JOIN ar.loan_application_info a ON a.id = l.application_id
WHERE l.application_id IN (468416,468420,468421)
AND p.proxy_id = 20
AND p.status = 2
AND p.id > 0
ORDER BY p.id
LIMIT 100
