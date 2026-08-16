import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CheckCheck, Eraser, MessageCircle, Share2, ThumbsUp } from "lucide-react";
import { ToolBar, ActionButton } from "@/components/ui/ToolBar";
import ContentLinkBanner from "@/components/ui/ContentLinkBanner";
import Segmented from "@/components/ui/Segmented";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useContentLink } from "@/lib/useContentLink";
import { startPolling } from "@/lib/poll";
import { FB_FILTER_KEY, activeMetrics, emptyRule, normalizeRule } from "@/lib/shared/feedFilter";

// Facebook research filter — sets the engagement rule the page script enforces on
// /search/* and /hashtag/*: posts that don't clear it are taken out of the feed as
// they scroll into range. The rule lives in chrome.storage (see FB_FILTER_KEY), so
// the page keeps filtering with this panel closed and after a reload.
//
// WHY THE FORM HOLDS STRINGS: a number input the user is halfway through clearing
// is "" — coercing on every keystroke would turn that into 0 and hide the whole
// feed between two keys. Strings here, normalizeRule at the boundary.
const METRICS = [
  { key: "likes", label: "Curtidas", Icon: ThumbsUp },
  { key: "comments", label: "Comentários", Icon: MessageCircle },
  { key: "shares", label: "Compart.", Icon: Share2 },
];

const MODES = [
  { id: "or", label: "Qualquer um", Icon: Check },
  { id: "and", label: "Todos", Icon: CheckCheck },
];

// How long a local edit keeps the poll from overwriting the form. The page echoes
// the rule back on every tick; without this, a value typed 200ms before a tick
// would be replaced by the one the page had not been told about yet.
const EDIT_GRACE_MS = 2500;
const PUSH_DEBOUNCE_MS = 400;

const toForm = (rule) => {
  const r = normalizeRule(rule);
  return {
    on: r.on,
    mode: r.mode,
    likes: r.min.likes == null ? "" : String(r.min.likes),
    comments: r.min.comments == null ? "" : String(r.min.comments),
    shares: r.min.shares == null ? "" : String(r.min.shares),
  };
};
const toRule = (form) =>
  normalizeRule({
    on: form.on,
    mode: form.mode,
    min: { likes: form.likes, comments: form.comments, shares: form.shares },
  });

export default function FbFilterTool() {
  const { link, noTab, fixing, send, revive, openTab } = useContentLink("facebook");
  const [form, setForm] = useState(() => toForm(emptyRule()));
  const [page, setPage] = useState(null); // { surface, hasFeed, stats }
  const lastEdit = useRef(0);
  const pushTimer = useRef(null);

  // The rule comes from STORAGE, not from the poll.
  //
  // The poll skips ticks while the panel is not visible (see startPolling), so a
  // panel opened behind another window could still be showing an empty form when
  // the user types into it — and the first push would then wipe the two thresholds
  // it had never been told about. Storage is readable regardless of visibility, is
  // what the page itself follows, and its change event keeps every open panel and
  // every Facebook tab on the same rule.
  useEffect(() => {
    if (!chrome?.storage?.local) return;
    let dead = false;
    const adopt = (raw) => {
      if (dead || Date.now() - lastEdit.current < EDIT_GRACE_MS) return;
      setForm(toForm(raw));
    };
    chrome.storage.local.get(FB_FILTER_KEY, (r) => adopt(r?.[FB_FILTER_KEY]));
    const onCh = (c, area) => {
      if (area === "local" && c[FB_FILTER_KEY]) adopt(c[FB_FILTER_KEY].newValue);
    };
    chrome.storage.onChanged.addListener(onCh);
    return () => {
      dead = true;
      chrome.storage.onChanged.removeListener(onCh);
    };
  }, []);

  // The poll only asks the page what it is looking at and how the filter is doing
  // there — facts that live in the tab, not in storage.
  const pull = useCallback(async () => {
    const res = await send({ type: "FBW_FBFILTER_STATE" });
    if (!res || !res.ok) return;
    setPage({ surface: res.surface, hasFeed: !!res.hasFeed, stats: res.stats || null });
  }, [send]);

  useEffect(() => startPolling(pull, 1000), [pull]);

  // Every edit goes to the page (and to storage, which the page owns) on a short
  // debounce, so dragging a threshold up digit by digit is one write, not four.
  const push = useCallback(
    (next) => {
      lastEdit.current = Date.now();
      setForm(next);
      clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(() => {
        send({ type: "FBW_FBFILTER_SET", rule: toRule(next) }).then((res) => {
          if (res?.ok) setPage({ surface: res.surface, hasFeed: !!res.hasFeed, stats: res.stats });
        });
      }, PUSH_DEBOUNCE_MS);
    },
    [send],
  );
  useEffect(() => () => clearTimeout(pushTimer.current), []);

  const setMin = (key, value) => push({ ...form, [key]: value.replace(/[^\d]/g, "") });
  const clear = () => push({ ...form, likes: "", comments: "", shares: "" });

  const rule = toRule(form);
  const active = activeMetrics(rule);
  const stats = page?.stats;
  const onSurface = !!page?.surface;

  const banner = (
    <ContentLinkBanner
      link={link}
      platformName="Facebook"
      fixing={fixing}
      onRevive={revive}
      onOpenTab={openTab}
    />
  );
  if (noTab) return banner;

  return (
    <div className="space-y-2">
      {banner}

      {/* Where the filter is (or isn't) working. Stated before the controls: a rule
          that looks armed while the tab sits on a profile is the one confusing
          state this tool can produce. */}
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="text-[13px] font-medium">
          {onSurface
            ? page.surface === "hashtag"
              ? "Feed de hashtag"
              : "Resultados da pesquisa"
            : "Fora de uma pesquisa"}
        </div>
        <div className="text-[11px] leading-relaxed text-muted-foreground">
          {onSurface
            ? page.hasFeed
              ? rule.on
                ? `${stats?.shown ?? 0} exibidos · ${stats?.hidden ?? 0} ocultos${
                    stats?.pending ? ` · ${stats.pending} ainda carregando` : ""
                  }`
                : "filtro desligado — todos os posts aparecem"
              : "abrindo o feed…"
            : "abra facebook.com/search ou uma hashtag para filtrar por engajamento"}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">Filtrar o feed</div>
          <div className="text-[11px] text-muted-foreground">
            {active.length ? "esconde quem não bate a regra" : "defina um mínimo abaixo"}
          </div>
        </div>
        <Switch
          checked={form.on}
          onCheckedChange={(on) => push({ ...form, on })}
          aria-label="Ligar o filtro de engajamento"
        />
      </div>

      <div className="space-y-1.5 rounded-lg border border-border bg-card p-3">
        {METRICS.map(({ key, label, Icon }) => (
          <label key={key} className="flex items-center gap-2">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[12px]">{label}</span>
            <span className="shrink-0 text-[12px] text-muted-foreground">≥</span>
            <Input
              value={form[key]}
              onChange={(e) => setMin(key, e.target.value)}
              inputMode="numeric"
              placeholder="—"
              aria-label={`Mínimo de ${label}`}
              className="h-8 w-20 shrink-0 text-right text-[12px]"
            />
          </label>
        ))}

        {/* The combinator only means something with two or more minimums — with one,
            E and OU are the same rule, so saying so beats a control that does
            nothing. */}
        <div className="pt-1">
          <Segmented
            value={form.mode}
            onChange={(mode) => push({ ...form, mode })}
            items={MODES}
          />
          <p className="pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {active.length < 2
              ? "com um único mínimo, os dois modos filtram igual"
              : form.mode === "and"
                ? "o post precisa bater TODOS os mínimos"
                : "basta bater UM dos mínimos"}
          </p>
        </div>
      </div>

      <ToolBar>
        <ActionButton
          className="basis-0 grow"
          icon={Eraser}
          label="Limpar mínimos"
          hint="Zerar os três campos — o feed volta a mostrar tudo"
          variant="outline"
          onClick={clear}
          disabled={!active.length}
        />
      </ToolBar>
    </div>
  );
}
