import { selectedRole, roleMember, memberId } from '../../shared/roles.js';
import { mapConcurrent } from './concurrency.js';
import { monthBounds, filterTasks } from '../../shared/month-filter.js';

const fail = message => Object.assign(Error(message), { code: 'WEB_RESPONSE_CHANGED' });
const idOf = value => typeof value === 'string' ? value : value?._id || value?.id || value?.uid;
const nameOf = value => value?.display_name || value?.name || value?.title || '';

function reference(references, type, id) {
  if (typeof id === 'object' && id) {
    return id;
  }
  return (references?.[type] || []).find(row => idOf(row) === id) || {};
}

export class WebClient {
  constructor(config, session) {
    this.config = config;
    this.session = session;
  }

  async pages(path, params, signal, onProgress = () => {}, query = false) {
    const rows = new Map();
    const references = {};
    let nextPage = 0;
    let total;
    let pageSize;
    for (;;) {
      const batchSize = nextPage === 0 ? 1 : Math.min(3, Math.max(1, Math.ceil((total - rows.size) / pageSize)));
      const indexes = Array.from({ length: batchSize }, (_, index) => nextPage + index);
      const bodies = await mapConcurrent(indexes, 3,
        (page, requestSignal) => query
          ? this.session.query(this.config.site, { ...params, ps: 100, pi: page }, requestSignal)
          : this.session.read(this.config.site, path, { ...params, ps: 100, pi: page }, requestSignal), signal);
      for (let index = 0; index < bodies.length; index++) {
        const body = bodies[index];
        if (!Array.isArray(body.value) || !Number.isSafeInteger(body.count) || body.count < 0
          || body.page_index !== indexes[index]) {
          throw fail('网页分页响应不符合预期，请检查插件更新');
        }
        if (total !== undefined && body.count !== total) {
          throw fail('读取期间任务列表数量发生变化，请重新查询以获得完整结果');
        }
        for (const [key, entries] of Object.entries(body.references || {})) {
          if (Array.isArray(entries)) {
            references[key] = [...new Map([...(references[key] || []), ...entries].map(row => [idOf(row), row])).values()];
          }
        }
        const before = rows.size;
        for (const row of body.value) {
          const id = idOf(row);
          if (!id) {
            throw fail('网页分页缺少工作项标识，无法完整统计');
          }
          rows.set(id, row);
        }
        total = body.count;
        if (nextPage === 0) {
          pageSize = Number.isSafeInteger(body.page_size) && body.page_size > 0 ? body.page_size : body.value.length;
        }
        nextPage++;
        onProgress({ phase: 'list', loaded: rows.size, total });
        if (before === rows.size && rows.size < total) {
          throw fail('网页分页未完整返回，本次结果不可统计');
        }
      }
      if (rows.size >= total) {
        return { rows: [...rows.values()], references };
      }
    }
  }

  async members(keywords, signal) {
    // The project picker returns the member roster visible to this account; no enterprise directory grant is needed.
    const { references } = await this.pages('/api/agile/pilot/entries', {}, signal);
    const rows = references.members || [];
    const query = keywords.toLocaleLowerCase();
    return rows.filter(row => `${nameOf(row)} ${row.name || ''}`.toLocaleLowerCase().includes(query))
      .map(row => ({ id: idOf(row), name: nameOf(row) || idOf(row), username: row.name || row.email || idOf(row) }));
  }

  async projects(signal) {
    const { rows } = await this.pages('/api/agile/pilot/entries', { sort_direction: 'asc' }, signal);
    return rows.filter(row => !row.is_archived && !row.is_deleted)
      .map(row => ({ id: idOf(row), name: row.name, identifier: row.identifier }));
  }

  async tasks({ assigneeId, projectId = '', role: roleId, month = '', dateField = 'completedAt', onProgress }, signal) {
    const role = selectedRole(roleId);
    if (!['completedAt', 'createdAt'].includes(dateField)) { throw fail('时间口径无效'); }
    const bounds = monthBounds(month);
    const dateKey = dateField === 'completedAt' ? 'completed_at' : 'created_at';
    if (!assigneeId) {
      throw fail('请先选择负责人');
    }
    const params = bounds ? { criteria: { condition_logic: 1, conditions: [
      { property_key: dateKey, operation: 2, value: bounds.start, logic: 1 },
      { property_key: dateKey, operation: 5, value: bounds.end, logic: 1 },
      ...(!role.key ? [{ property_key: 'assignee', operation: 6, value: [assigneeId], logic: 1 }] : [])
    ] }, ...(projectId ? { project_id: projectId } : {}) } : {};
    if (bounds && !this.session.query) {
      throw Object.assign(Error('请更新浏览器扩展后使用按月查询'), { code: 'EXTENSION_UPDATE_REQUIRED' });
    }
    const { rows, references } = await this.pages('/api/agile/work-items', params, signal, onProgress, Boolean(bounds));
    if (bounds && rows.some(row => !Number.isFinite(row[dateKey]) || row[dateKey] < bounds.start || row[dateKey] >= bounds.end)) {
      throw fail('网页接口未按所选月份返回任务，请检查插件和扩展版本后重试');
    }
    const selected = rows.filter(row => (role.key || idOf(row.assignee) === assigneeId)
      && (!projectId || idOf(row.project_id || row.project) === projectId)
      && !row.is_deleted && !row.is_archived);
    const candidates = selected.filter(row => !role.key || !Object.hasOwn(row.properties || {}, role.key)
      || memberId(roleMember(row, role)) === assigneeId);
    const needsDetail = row => !Object.hasOwn(row.properties || {}, this.config.valueKey)
      || !Object.hasOwn(row, 'created_at') || !Object.hasOwn(row, 'completed_at')
      || (role.key && !Object.hasOwn(row.properties || {}, role.key));
    const detailTotal = candidates.filter(needsDetail).length;
    let detailLoaded = 0;
    if (detailTotal) {
      onProgress?.({ phase: 'details', loaded: 0, total: detailTotal });
    }
    const result = await mapConcurrent(candidates, 4, async (listed, requestSignal) => {
      let row = listed;
      let refs = references;
      if (needsDetail(row)) {
        const detail = await this.session.read(this.config.site,
          `/api/agile/work-items/${encodeURIComponent(row.short_id || idOf(row))}`, {}, requestSignal);
        if (!detail.value || idOf(detail.value) !== idOf(listed)) {
          throw fail('工作项详情不符合预期，本次结果不可统计');
        }
        row = detail.value;
        refs = { ...references, ...detail.references };
        onProgress?.({ phase: 'details', loaded: ++detailLoaded, total: detailTotal });
      }
      if (memberId(roleMember(row, role)) !== assigneeId) {
        return null;
      }
      return { id: idOf(row), number: row.whole_identifier || String(row.identifier || ''), title: row.title || '',
        project: nameOf(reference(refs, 'projects', row.project_id || row.project)),
        assignee: nameOf(reference(refs, 'members', roleMember(row, role))),
        stateId: idOf(row.state_id || row.state) || '', state: nameOf(reference(refs, 'states', row.state_id || row.state)) || '未设置',
        score: row.properties?.[this.config.valueKey] ?? null,
        createdAt: row.created_at ?? null, completedAt: row.completed_at ?? null,
        url: row.short_id ? `${this.config.site}/pjm/workitems/${encodeURIComponent(row.short_id)}` : '' };
    }, signal);
    return filterTasks(result.filter(Boolean), { month, dateField });
  }
}
