// TikTok's field map for the feed query (./feedQuery.js). Canonical source —
// INLINED into the TikTok relay (see ./README.md), imported by the panel. Keys the
// old sort select used (vpf, views, likes, comments, shares, saves, er, followers,
// date) are kept, so a stored choice survives the move to the query.
import { ttEngagementRate, ttViewsPerFollower } from "./ttFormat.js";
import { viewsPerDay } from "./fmt.js";

const ttPer = (num, den) => (num == null || !den || den <= 0 ? null : (num / den) * 100);

export const TT_QUERY_FIELDS = {
  vpf: { label: "Alcance (×)", short: "Alcance", kind: "number", get: (r) => ttViewsPerFollower(r) },
  views: { label: "Visualizações", short: "Visualiz.", kind: "number", get: (r) => r.play_count },
  velocity: { label: "Velocidade (views/dia)", short: "Views/dia", kind: "number", get: (r) => viewsPerDay(r.play_count, r.create_time) },
  likes: { label: "Curtidas", kind: "number", get: (r) => r.digg_count },
  comments: { label: "Comentários", short: "Coment.", kind: "number", get: (r) => r.comment_count },
  shares: { label: "Compartilhamentos", short: "Compart.", kind: "number", get: (r) => r.share_count },
  saves: { label: "Salvamentos", short: "Salvos", kind: "number", get: (r) => r.collect_count },
  er: { label: "TE %", kind: "number", get: (r, ctx) => ttEngagementRate(r, ctx && ctx.weights) },
  likeRate: { label: "Curtidas / views %", short: "Curt./view", kind: "number", get: (r) => ttPer(r.digg_count, r.play_count) },
  commentRate: { label: "Comentários / views %", short: "Com./view", kind: "number", get: (r) => ttPer(r.comment_count, r.play_count) },
  shareRate: { label: "Compart. / views %", short: "Comp./view", kind: "number", get: (r) => ttPer(r.share_count, r.play_count) },
  saveRate: { label: "Salvos / views %", short: "Salv./view", kind: "number", get: (r) => ttPer(r.collect_count, r.play_count) },
  followers: { label: "Seguidores", short: "Segs.", kind: "number", sortable: false, get: (r) => r.user_follower_count },
  duration: { label: "Duração (s)", short: "Duração", kind: "number", sortable: false, get: (r) => r.duration },
  date: { label: "Data", kind: "date", get: (r) => r.create_time },
  caption: { label: "Legenda", kind: "text", get: (r) => r.desc },
  hashtags: { label: "Hashtags", kind: "text", get: (r) => r.hashtags },
  username: { label: "Perfil", kind: "text", get: (r) => r.username },
};
