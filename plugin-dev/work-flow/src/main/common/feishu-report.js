import { splitFeishuText } from './feishu-robot.js';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const markdown = content => ({ tag: 'markdown', content });

// Decode the escaping emitted by payoutReport; table cells use plain text to prevent mentions or markup execution.
function cells(line) {
  const values = [];
  let value = '';
  const source = line.trim().slice(1, -1);
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\' && index + 1 < source.length) {
      value += source[++index];
    } else if (char === '|') {
      values.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value.trim());
  return values.map(text => text.replace(/&(amp|lt|gt);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>' })[name]));
}

function tableBlocks(header, rows, heading) {
  const columns = cells(header).map((display_name, index) => ({ name: `c${index}`, display_name, data_type: 'text', width: 'auto' }));
  const blocks = [];
  let batch = [];
  const block = items => [markdown(heading || '订单明细'), { tag: 'table', page_size: 10, row_height: 'low',
    header_style: { bold: true, background_style: 'grey' }, columns, rows: items }];
  for (const line of rows) {
    const values = cells(line);
    if (values.length !== columns.length) {
      throw Error('报告表格列数不一致，未发送任何消息');
    }
    const row = Object.fromEntries(values.map((value, index) => [`c${index}`, value]));
    if (bytes(block([row])) > 14000) {
      throw Error('报告单行过长，无法完整放入飞书表格；未发送任何消息');
    }
    if (batch.length === 10 || bytes(block([...batch, row])) > 14000) {
      blocks.push(block(batch));
      batch = [];
    }
    batch.push(row);
  }
  if (batch.length) {
    blocks.push(block(batch));
  }
  return blocks;
}

function reportBlocks(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  const headings = [];
  let prose = [];
  const flush = () => {
    const content = prose.join('\n').trim();
    for (const part of splitFeishuText(content ? [...headings, content].filter(Boolean).join('\n\n') : '')) {
      blocks.push([markdown(part)]);
    }
    prose = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('# ')) {
      continue;
    }
    const heading = /^(#{2,6}) /.exec(line);
    if (heading) {
      flush();
      headings.length = heading[1].length - 1;
      headings[heading[1].length - 2] = line;
    } else if (line.startsWith('|') && /^\|[\s:|-]+\|\s*$/.test(lines[index + 1] || '')) {
      flush();
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].startsWith('|')) {
        rows.push(lines[index++]);
      }
      index--;
      blocks.push(...tableBlocks(line, rows, headings.filter(Boolean).join('\n\n')));
    } else {
      prose.push(line);
    }
  }
  flush();
  return blocks;
}

// Native table components need no HTML renderer; ten visible rows avoid hidden pagination in webhook notifications.
export function buildFeishuReportCards(text) {
  const title = text.match(/^# (.+)$/m)?.[1] || '工作流报告';
  const card = elements => ({ schema: '2.0', config: { width_mode: 'fill' },
    header: { title: { tag: 'plain_text', content: title }, template: 'blue' }, body: { elements } });
  const cards = [];
  let elements = [];
  let tables = 0;
  for (const block of reportBlocks(text)) {
    const count = block.filter(item => item.tag === 'table').length;
    if (elements.length && (tables + count > 5 || bytes(card([...elements, ...block])) > 15500)) {
      cards.push(card(elements));
      elements = [];
      tables = 0;
    }
    if (bytes(card(block)) > 15500) {
      throw Error('报告内容过长，无法完整放入飞书卡片；未发送任何消息');
    }
    elements.push(...block);
    tables += count;
  }
  if (elements.length) {
    cards.push(card(elements));
  }
  if (!cards.length && text.trim()) {
    cards.push(card([markdown(title)]));
  }
  if (!cards.length || cards.length > 60) {
    throw Error('报告为空或超过60张卡片，未发送任何消息');
  }
  return cards.map((item, index) => ({ ...item, header: { ...item.header,
    title: { tag: 'plain_text', content: title + (cards.length > 1 ? `（${index + 1}/${cards.length}）` : '') } } }));
}
