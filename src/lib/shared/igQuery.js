// Instagram's field map for the feed query (./feedQuery.js). Canonical source —
// INLINED into the Instagram bridge (see ./README.md), imported by the panel.
// Keys the old sort select used (views, likes, comments, er, date) are kept, so a
// stored choice survives the move to the query.
import { engagementRate } from "./igFormat.js";
import { viewsPerDay } from "./fmt.js";

const igPer = (num, den) => (num == null || !den || den <= 0 ? null : (num / den) * 100);

export const IG_QUERY_FIELDS = {
  views: { label: "Visualizações", short: "Visualiz.", kind: "number", get: (r) => r.play_count },
  velocity: { label: "Velocidade (views/dia)", short: "Views/dia", kind: "number", get: (r) => viewsPerDay(r.play_count, r.taken_at) },
  likes: { label: "Curtidas", kind: "number", get: (r) => r.like_count },
  comments: { label: "Comentários", short: "Coment.", kind: "number", get: (r) => r.comment_count },
  reposts: { label: "Reposts", kind: "number", get: (r) => r.repost },
  er: { label: "TE %", kind: "number", get: (r, ctx) => engagementRate(r, ctx && ctx.weights) },
  likeRate: { label: "Curtidas / views %", short: "Curt./view", kind: "number", get: (r) => igPer(r.like_count, r.play_count) },
  commentRate: { label: "Comentários / views %", short: "Com./view", kind: "number", get: (r) => igPer(r.comment_count, r.play_count) },
  repostRate: { label: "Reposts / views %", short: "Rep./view", kind: "number", get: (r) => igPer(r.repost, r.play_count) },
  vpf: {
    label: "Alcance (×)",
    short: "Alcance",
    kind: "number",
    get: (r) => (r.play_count == null || !r.user_follower_count ? null : r.play_count / r.user_follower_count),
  },
  followers: { label: "Seguidores", short: "Segs.", kind: "number", sortable: false, get: (r) => r.user_follower_count },
  duration: { label: "Duração (s)", short: "Duração", kind: "number", sortable: false, get: (r) => r.duration },
  date: { label: "Data", kind: "date", get: (r) => r.taken_at },
  caption: { label: "Legenda", kind: "text", get: (r) => r.caption },
  username: { label: "Perfil", kind: "text", get: (r) => r.username },
  type: {
    label: "Tipo",
    kind: "enum",
    values: [["video", "Vídeo"], ["photo", "Foto"], ["carousel", "Carrossel"]],
    get: (r) => r.media_type || (r.video ? "video" : "photo"),
  },
};
