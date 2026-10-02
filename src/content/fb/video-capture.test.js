// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/content/fb/video-capture.js", "utf8");

describe("Facebook SPA video capture", () => {
  it.each(["/search/top", "/"])("replays videos delivered before Facebook commits the URL, coming from %s", (pathname) => {
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
});
