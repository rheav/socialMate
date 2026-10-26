import { Eye, Heart, MessageCircle, Play } from "lucide-react";
import { cn } from "@/dashboard/lib/utils";
import type { SpyTopItem } from "../api";
import { fmtCount } from "../format";

const when = (s: number) => new Date(s * 1000).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
const figure = (item: SpyTopItem) =>
  item.metric === "views" ? { Icon: Eye, value: fmtCount(item.views) ?? "—" } : { Icon: Heart, value: fmtCount(item.likes) ?? "—" };

function Tile({ item, className, children }: { item: SpyTopItem; className?: string; children?: React.ReactNode }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`${when(item.createdAt)} · ${item.views != null ? `${fmtCount(item.views)} visualizações · ` : ""}${fmtCount(item.likes) ?? "—"} curtidas`}
      className={cn("group/tile relative block overflow-hidden rounded-md bg-secondary", className)}
    >
      {item.thumbUrl ? (
        <img src={item.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover/tile:scale-105" />
      ) : (
        <div className="grid h-full w-full place-items-center text-muted-foreground/60"><Play size={16} /></div>
      )}
      {children}
    </a>
  );
}

/** Card slot: three tiles with the number they rank by. Empty slots keep their place. */
export function TopThumbs({ items }: { items: SpyTopItem[] }) {
  return (
    <div className="grid h-[70px] grid-cols-3 gap-1.5">
      {[0, 1, 2].map((i) => {
        const item = items[i];
        if (!item) return <div key={i} className="rounded-md border border-dashed border-border/70" />;
        const { Icon, value } = figure(item);
        return (
          <Tile key={item.id} item={item} className="h-full">
            <span className="absolute inset-x-0 bottom-0 flex items-center gap-0.5 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-3 text-[10px] font-semibold text-white">
              <Icon size={10} className="shrink-0" /> {value}
            </span>
          </Tile>
        );
      })}
    </div>
  );
}

/** Profile sheet: the same three, larger, with every number we have. */
export function TopList({ items }: { items: SpyTopItem[] }) {
  if (!items.length) return <p className="text-xs text-muted-foreground">Nenhum post nos últimos 7 dias.</p>;
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((item, rank) => (
        <div key={item.id} className="min-w-0 space-y-1.5">
          <Tile item={item} className="aspect-[9/16]">
            <span className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-[10px] font-bold text-white">{rank + 1}</span>
          </Tile>
          <div className="space-y-0.5 text-[11px] leading-4 text-muted-foreground">
            {item.views != null && <div className="flex items-center gap-1 font-semibold text-foreground"><Eye size={11} /> {fmtCount(item.views)}</div>}
            <div className="flex items-center gap-2">
              {item.likes != null && <span className={cn("flex items-center gap-1", item.metric === "likes" && "font-semibold text-foreground")}><Heart size={11} /> {fmtCount(item.likes)}</span>}
              {item.comments != null && <span className="flex items-center gap-1"><MessageCircle size={11} /> {fmtCount(item.comments)}</span>}
            </div>
            <div>{when(item.createdAt)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
