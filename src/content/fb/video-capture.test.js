// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/content/fb/video-capture.js", "utf8");

describe("Facebook SPA video capture", () => {
  it('captures owner-only hydration fragments on a direct reel, even without delivery fields', () => {
    const script=document.createElement('script');script.type='application/json';
    script.textContent=JSON.stringify({data:{__typename:'Video',id:'2030018604348103',owner:{id:'100092403319843',name:'Spiritual Revelations'}}});
    document.body.appendChild(script);
    const messages=[], listeners={};
    const browser={postMessage:m=>messages.push(m),addEventListener:(k,fn)=>{listeners[k]=fn;}};
    const location={href:'https://www.facebook.com/reel/2030018604348103',pathname:'/reel/2030018604348103',origin:'https://www.facebook.com'};
    class XHR extends EventTarget {open(){} send(){}}
    new Function('window','document','location','XMLHttpRequest','DOMParser',source)(browser,document,location,XHR,DOMParser);
    listeners.message({source:browser,data:{type:'__fbwReelRecordsRequest'}});
    script.remove();
    expect(messages.at(-1).rows[0]).toMatchObject({authorName:'Spiritual Revelations'});
  });
  it('captures profile pagination and replays compact reel records', () => {
    const messages = [], listeners = {};
    const browser = { postMessage: msg => messages.push(msg), addEventListener: (name, fn) => { listeners[name] = fn; } };
    const location = { href: 'https://www.facebook.com/profile.php?id=123&sk=reels_tab', pathname: '/profile.php', origin: 'https://www.facebook.com' };
    class XHR extends EventTarget { open() {} send() {} }
    new Function('window', 'document', 'location', 'XMLHttpRequest', 'DOMParser', source)(browser, document, location, XHR, DOMParser);
    const xhr = new XHR(); xhr.open('POST', '/api/graphql/');
    xhr.send('fb_api_req_friendly_name=ProfileCometAppCollectionReelsRendererPaginationQuery');
    xhr.responseText = JSON.stringify({data: {url: 'https://www.facebook.com/reel/2030018604348103/', feedback: {total_comment_count: 32, share_count_reduced: '2.2K'}}});
    xhr.dispatchEvent(new Event('load'));
    expect(messages.find(m => m.type === '__fbwReelRecords')?.rows[0]).toMatchObject({id:'2030018604348103',shares:2200});
    listeners.message({source:browser,data:{type:'__fbwReelRecordsRequest'}});
    expect(messages.at(-1).rows[0].comments).toBe(32);
  });
  it.each(["/search/top", "/", "/reel/2030018604348103", "/profile.php"])("replays videos delivered before Facebook commits the URL, coming from %s", (pathname) => {
    const messages = [], listeners = {};
    const browser = { postMessage: msg => messages.push(msg), addEventListener: (name, fn) => { listeners[name] = fn; } };
    const location = { href: `https://www.facebook.com${pathname}?q=first`, pathname, origin: "https://www.facebook.com" };
    class XHR extends EventTarget { open() {} send() {} }
    new Function("window", "document", "location", "XMLHttpRequest", "DOMParser", source)(browser, document, location, XHR, DOMParser);
    const xhr = new XHR();
    xhr.open("POST", "/api/graphql/");
    xhr.send("fb_api_req_friendly_name=SearchCometResultsPaginatedResultsQuery");
    xhr.responseText = JSON.stringify({ data: { __typename: "Video", id: "823150870841024",
      first_frame_thumbnail: "https://scontent.fbcdn.net/cover.jpg",
      videoDeliveryResponseFragment: { videoDeliveryResponseResult: { progressive_urls: [{ progressive_url: "https://scontent.fbcdn.net/video.mp4" }] } },
    } });
    xhr.dispatchEvent(new Event("load"));
    expect(messages.at(-1).rows[0].id).toBe("823150870841024");
    location.href = "https://www.facebook.com/search/top?q=second";
    location.pathname = "/search/top";
    listeners.message({ source: browser, data: { type: "__fbwVideoRecordsRequest" } });
    expect(messages.at(-1).route).toBe(location.href);
    expect(messages.at(-1).rows[0].id).toBe("823150870841024");
  });
  it("answers the Spy worker's first reels page from the page's own data, only in its tab", async () => {
    const script = document.createElement("script"); script.type = "application/json";
    script.textContent = JSON.stringify({ x: { id: "COLL", aggregated_fb_shorts: { page_info: { end_cursor: "C1", has_next_page: true }, edges: [
      { profile_reel_node: { node: { __typename: "Story", creation_time: 1791000000, actors: [{ id: "6" }],
        attachments: [{ media: { __typename: "Video", id: "2209826979599628", created_time: 1791000000, play_count_reduced: "9.1K" } }] } } },
    ] } } });
    document.body.appendChild(script);
    const run = async (hash) => {
      const messages = [], listeners = {};
      const browser = { postMessage: (m) => messages.push(m), addEventListener: (k, fn) => { listeners[k] = fn; } };
      const location = { href: "https://www.facebook.com/profile.php?id=6&sk=reels_tab" + hash, pathname: "/profile.php", hash, origin: "https://www.facebook.com" };
      class XHR extends EventTarget { open() {} send() {} }
      new Function("window", "document", "location", "XMLHttpRequest", "DOMParser", source)(browser, document, location, XHR, DOMParser);
      listeners.message({ source: browser, data: { type: "__fbwSpyReelsPage", reqId: "r1", cursor: null } });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      return messages.filter((m) => m.type === "__fbwSpyReelsPageResult");
    };
    expect(await run("#socialmate-reels")).toEqual([expect.objectContaining({ reqId: "r1", ok: true, collectionId: "COLL", cursor: "C1", hasNext: true,
      rows: [{ id: "2209826979599628", createdAt: 1791000000, duration: null, views: 9100, thumbUrl: null }] })]);
    expect(await run("")).toEqual([]);
    script.remove();
  });
});
