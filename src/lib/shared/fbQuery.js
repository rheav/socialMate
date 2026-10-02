import { viewsPerDay } from "./fmt.js";

// Shares on Facebook are not Instagram reposts. Keep the formula explicit and
// return unknown until every input has arrived (including the deferred likes).
export function fbEngagement(r) {
  return r.views > 0 && [r.likes, r.comments, r.shares].every(Number.isFinite)
    ? (r.likes + 4 * r.comments + 4 * r.shares) / r.views * 100 : null;
}
const fbRate = (n, d) => n != null && d > 0 ? n / d * 100 : null;
export const FB_QUERY_FIELDS = {
  views: { label: 'Visualizações', short: 'Views', kind: 'number', get: r => r.views },
  likes: { label: 'Curtidas', kind: 'number', get: r => r.likes },
  comments: { label: 'Comentários', kind: 'number', get: r => r.comments },
  shares: { label: 'Compartilhamentos', short: 'Compart.', kind: 'number', get: r => r.shares },
  date: { label: 'Publicação', kind: 'date', get: r => r.taken_at },
  velocity: { label: 'Views/dia', kind: 'number', get: r => viewsPerDay(r.views, r.taken_at) },
  er: { label: 'Engajamento %', kind: 'number', get: fbEngagement },
  likeRate: { label: 'Curtidas / views %', kind: 'number', get: r => fbRate(r.likes, r.views) },
  commentRate: { label: 'Comentários / views %', kind: 'number', get: r => fbRate(r.comments, r.views) },
  shareRate: { label: 'Compart. / views %', kind: 'number', get: r => fbRate(r.shares, r.views) },
  duration: { label: 'Duração (s)', kind: 'number', sortable: false, get: r => r.duration },
  followers: { label: 'Seguidores', kind: 'number', sortable: false, get: r => r.followers },
  reach: { label: 'Views / seguidores', kind: 'number', get: r => r.followers > 0 && r.views != null ? r.views / r.followers : null },
  caption: { label: 'Descrição', kind: 'text', get: r => r.caption },
  author: { label: 'Autor', kind: 'text', get: r => r.authorName },
};
