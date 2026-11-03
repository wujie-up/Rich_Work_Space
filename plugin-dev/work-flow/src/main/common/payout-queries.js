const countries = {
  AR: ['阿根廷', 'ar'], BR: ['巴西', 'br'], CL: ['智利', 'cl'], CO: ['哥伦比亚', 'co'], MX: ['墨西哥', 'dbai'],
  PE: ['秘鲁', 'pe'], VE: ['委内瑞拉', 've'], MY: ['马来西亚', 'my'], IN: ['印度', 'india'], KR: ['韩国', 'kr'],
  KZ: ['哈撒克斯坦', 'kz'], TR: ['土耳其', 'tr'], AO: ['安哥拉', 'ao'], EG: ['埃及', 'eg'], ZA: ['南非', 'za']
};

export function payoutCountryLabel(country) {
  const name = countries[country]?.[0];
  return name ? `${name}（${country}）` : country;
}

function id(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) {
    throw Error('ID 必须是十进制字符串，不能先转为 JavaScript Number');
  }
  return value;
}

export function runContext() {
  return { database: 'treasury', limit: 2, sql: `SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS as_of,
CAST(COALESCE(MAX(id), 0) AS CHAR) AS high_water
FROM financial.payment_channel_trade_event_record` };
}

// Restrict configurable SQL intervals to whole hours within the one-month inspection window.
export function callbackTimeoutHours(value = 6) {
  const hours = typeof value === 'number' || typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(hours) || hours < 1 || hours > 744) {
    throw Error('未回调超时必须为1–744之间的整数小时');
  }
  return hours;
}

export function financialPage({ asOf, highWater, cursor = '0', timeoutHours = 6 }) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(asOf)) {
    throw Error('asOf 必须使用财务库返回的固定时间');
  }
  return { database: 'treasury', limit: 100, sql: `SELECT CAST(e.id AS CHAR) AS event_record_id,
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
AND e.create_time >= '${asOf}' - INTERVAL 1 MONTH
AND e.create_time < '${asOf}' - INTERVAL ${callbackTimeoutHours(timeoutHours)} HOUR
AND e.id > ${id(cursor)}
AND e.id <= ${id(highWater)}
ORDER BY e.id
LIMIT 100` };
}

// Each batch has one country and old-system proxy ID; IDs from another country must never be mixed in.
// Read the saved payout reference; retry timestamps make rebuilding it from the application ID unreliable.
export function countryPage({ country, applicationIds, channelId, cursor = '0' }) {
  const mapping = countries[country];
  if (!mapping) {
    throw Error(`尚未核实国家 ${country} 的旧库映射，不允许跳过或猜测`);
  }
  if (!Array.isArray(applicationIds) || applicationIds.length < 1 || applicationIds.length > 100) {
    throw Error('每批需要 1–100 个申请单 ID');
  }
  const [database, schema] = mapping;
  const applicationFilter = [...new Set(applicationIds.map(id))].join(',');
  return { database, limit: 100, sql: `SELECT CAST(l.application_id AS CHAR) AS application_id,
CAST(l.id AS CHAR) AS loan_order_id,
CAST(p.id AS CHAR) AS payment_record_id,
p.proxy_id AS channel_id,
p.status AS payment_status,
l.payment_code AS channel_order_no,
DATE_FORMAT(a.application_time, '%Y-%m-%d %H:%i:%s') AS application_time,
DATE_FORMAT(p.create_time, '%Y-%m-%d %H:%i:%s') AS payment_create_time
FROM ${schema}.loan_order_info l
JOIN ${schema}.payment_record p ON p.order_id = l.id
LEFT JOIN ${schema}.loan_application_info a ON a.id = l.application_id
WHERE l.application_id IN (${applicationFilter})
AND p.proxy_id = ${id(channelId)}
AND p.status = 2
AND p.id > ${id(cursor)}
ORDER BY p.id
LIMIT 100` };
}
