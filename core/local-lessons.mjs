import path from 'node:path';
import { z } from 'zod';
import { atomicJson, id, readJson } from './util.mjs';
import { diagnosticValue } from './diagnostics.mjs';

const text = max => z.string().trim().min(1).max(max);
const lesson = z.object({
  trigger: text(72),
  guidance: text(140),
  keywords: z.array(text(24)).min(1).max(6),
  source: z.enum(['reproduced', 'user-confirmed']),
  evidence: text(160),
}).strict();

export const localLessonsShape = {
  action: z.enum(['search', 'save', 'forget']).default('search'),
  projectId: text(128).optional(),
  query: text(6000).optional(),
  lessonId: z.string().uuid().optional(),
  lesson: lesson.optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(6).default(4),
};

const normalize = value => (value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const sameScope = (item, projectId) => (item.projectId ?? null) === (projectId ?? null);

export class LocalLessons {
  constructor(home) {
    this.file = path.join(home, 'local-lessons.json');
    this.writing = Promise.resolve();
  }

  async read() {
    return readJson(this.file, []);
  }

  change(apply) {
    const operation = this.writing.catch(() => {}).then(async () => {
      const items = await this.read();
      const result = apply(items);
      await atomicJson(this.file, items);
      return result;
    });
    this.writing = operation;
    return operation;
  }

  async matches({ projectId, query, lessonId }) {
    const term = normalize(query);
    const items = await this.read();
    return items.flatMap(item => {
      if ((item.projectId && !sameScope(item, projectId)) || (lessonId && item.id !== lessonId)) return [];
      const overlap = item.keywords.filter(keyword => {
        const word = normalize(keyword);
        return term && (term.includes(word) || word.includes(term));
      }).length;
      const exact = term && normalize(item.trigger + ' ' + item.guidance).includes(term);
      if (term && !overlap && !exact) return [];
      return [{ item, score: overlap * 2 + (exact ? 1 : 0) + (item.projectId ? 1 : 0) }];
    }).sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
      .map(({ item }) => item);
  }

  async hints(projectId, query) {
    if (!normalize(query)) return [];
    const items = await this.matches({ projectId, query });
    return items.slice(0, 2).map(({ id, projectId, trigger, guidance, source }) => ({ id, projectId, trigger, guidance, source }));
  }

  async handle({ action, projectId, query, lessonId, lesson, offset, limit }) {
    if (action === 'search') {
      const matches = await this.matches({ projectId, query, lessonId });
      const items = matches.slice(offset, offset + limit);
      return { items, nextOffset: offset + items.length < matches.length ? offset + items.length : null };
    }
    if (action === 'forget' && !lessonId) throw new Error('删除经验需要 lessonId');
    if (action === 'save' && !lesson) throw new Error('保存经验需要触发条件、做法、关键词和验证依据');
    const clean = lesson && diagnosticValue(lesson);
    return this.change(items => {
      const index = items.findIndex(item => sameScope(item, projectId) &&
        (lessonId ? item.id === lessonId : normalize(item.trigger) === normalize(clean.trigger)));
      if (lessonId && index < 0) throw new Error('当前范围内找不到这条经验');
      if (action === 'forget') {
        items.splice(index, 1);
        return { forgotten: lessonId };
      }
      const previous = items[index];
      const saved = { ...clean, id: previous?.id || id(), projectId: projectId || null, updatedAt: new Date().toISOString() };
      if (previous) items[index] = saved;
      else items.push(saved);
      return { item: saved };
    });
  }

  async close() {
    await this.writing.catch(() => {});
  }
}
