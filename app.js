const API = "https://laws.e-gov.go.jp/api/2/law_data/";
const SEARCH_API = "https://laws.e-gov.go.jp/api/2/laws";
const REVISION_API = "https://laws.e-gov.go.jp/api/2/law_revisions/";
const CACHE_NAME = "law-text-cache-v1";
const LAW_REVISION_INDEX_KEY = "law-latest-revision-index";
const MAX_VIEW_HISTORY = 15;
const RETAINED_LAW_IDS = [
  "321CONSTITUTION",
  "129AC0000000089",
  "132AC0000000048",
  "417AC0000000086",
  "408AC0000000109",
  "140AC0000000045",
  "323AC0000000131",
  "322AC0000000125",
  "405AC0000000088",
  "426AC0000000068",
  "337AC0000000139",
];

function readRevisionIndex() {
  try {
    const index = JSON.parse(localStorage.getItem(LAW_REVISION_INDEX_KEY) || "{}");
    return index && typeof index === "object" ? index : {};
  } catch {
    return {};
  }
}

function writeRevisionIndex(index) {
  try {
    localStorage.setItem(LAW_REVISION_INDEX_KEY, JSON.stringify(index));
  } catch { /* Storage might be unavailable or full */ }
}

function setIndexedLatestRevision(lawId, revisionId) {
  if (!lawId || !revisionId) return;
  const index = readRevisionIndex();
  index[lawId] = revisionId;
  writeRevisionIndex(index);
}

function lawDataUrl(targetId) {
  return API + encodeURIComponent(targetId) + "?" + new URLSearchParams({
    response_format: "json",
    law_full_text_format: "json",
    json_format: "full"
  });
}

function getRevisionEnforcementDate(revisionInfo) {
  return revisionInfo?.amendment_enforcement_date || "";
}

function getTodayString() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const part = type => parts.find(p => p.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function isEnforcedRevision(revisionInfo, today = getTodayString()) {
  const date = getRevisionEnforcementDate(revisionInfo);
  return Boolean(date && date <= today);
}

function findLatestRevision(revisions) {
  const today = getTodayString();
  const validRevisions = (revisions || []).filter(r => isEnforcedRevision(r, today));
  if (!validRevisions.length) return revisions?.[0] || null;
  return validRevisions.reduce((latest, current) => {
    const latestDate = getRevisionEnforcementDate(latest);
    const currentDate = getRevisionEnforcementDate(current);
    if (!latestDate || currentDate > latestDate) return current;
    if (currentDate === latestDate && (current.law_revision_id || "") > (latest.law_revision_id || "")) {
      return current;
    }
    return latest;
  }, validRevisions[0]);
}

async function findLatestCachedRevision(lawId) {
  if (!("caches" in window)) return null;
  const cache = await caches.open(CACHE_NAME);
  const index = readRevisionIndex();
  const indexedRevisionId = index[lawId];
  if (!indexedRevisionId) return null;
  const cachedResponse = await cache.match(lawDataUrl(indexedRevisionId));
  if (!cachedResponse) return null;
  try {
    return await cachedResponse.json();
  } catch {
    return null;
  }
}

async function fetchLawData(targetId) {
  const cacheAvailable = "caches" in window;
  const cache = cacheAvailable ? await caches.open(CACHE_NAME) : null;
  const isRevision = targetId.includes("_");

  if (cache) {
    if (isRevision) {
      const cachedResponse = await cache.match(lawDataUrl(targetId));
      if (cachedResponse) {
        console.log(`Cache hit: ${targetId}`);
        return await cachedResponse.json();
      }
    } else {
      const latestCached = await findLatestCachedRevision(targetId);
      if (latestCached) {
        console.log(`Cache hit: ${latestCached.revision_info?.law_revision_id || targetId}`);
        return latestCached;
      }
    }
  }

  const response = await fetch(lawDataUrl(targetId));
  if (!response.ok) throw new Error(`法令APIから本文を取得できませんでした（${response.status}）。`);
  const data = await response.json();

  if (cache && data && !data.error && data.law_full_text) {
    const revisionId = data.revision_info?.law_revision_id || (isRevision ? targetId : null);
    if (revisionId) {
      await cache.put(lawDataUrl(revisionId), new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
      }));
    }
  }

  return data;
}

async function trimUnusedCache() {
  if (!("caches" in window)) return;
  try {
    const pinned = readPinnedLaws();
    const history = readViewHistory();
    const index = readRevisionIndex();
    const indexedRevisionIds = RETAINED_LAW_IDS.map(id => index[id]);
    const retainedIds = new Set(
      [...pinned, ...history].map(entry => entry.id)
        .concat(indexedRevisionIds)
        .filter(Boolean)
    );
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    for (const req of requests) {
      if (!req.url.startsWith(API)) continue;
      const target = req.url.slice(API.length).split("?")[0];
      const id = decodeURIComponent(target);
      if (!retainedIds.has(id)) {
        await cache.delete(req);
      }
    }
  } catch { /* Ignore cache trimming errors */ }
}

async function deleteCachedLawData(revisionId) {
  if (!("caches" in window) || !revisionId) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(lawDataUrl(revisionId));
  } catch { /* Ignore cache deletion errors */ }
}


const VIEW_HISTORY_KEY = "law-view-history";
const PINNED_LAWS_KEY = "law-pinned-laws";
const params = new URLSearchParams(location.search);
const lawId = params.get("id");
const status = document.querySelector("#status");
const content = document.querySelector("#content");
const previousMarkerButton = document.querySelector("#previous-marker");
const nextMarkerButton = document.querySelector("#next-marker");
const markerHistory = [location.hash || "#title"];
let markerHistoryIndex = 0;
let restoringMarker = false;

function updateMarkerButtons() {
  previousMarkerButton.disabled = markerHistoryIndex === 0;
  nextMarkerButton.disabled = markerHistoryIndex >= markerHistory.length - 1;
}

function setUrlMarker(hash, { remember = true } = {}) {
  const targetHash = hash || "#title";
  if (location.hash === targetHash) return;
  if (remember) {
    markerHistory.splice(markerHistoryIndex + 1);
    markerHistory.push(targetHash);
    markerHistoryIndex = markerHistory.length - 1;
  }
  history.replaceState(null, "", `${location.pathname}${location.search}${targetHash}`);
  updateMarkerButtons();
}

function navigateToMarker(hash, target, behavior = "auto") {
  setUrlMarker(hash);
  target?.scrollIntoView({ block: "start", behavior });
}

function moveInMarkerHistory(offset) {
  const nextIndex = markerHistoryIndex + offset;
  if (nextIndex < 0 || nextIndex >= markerHistory.length) return;
  markerHistoryIndex = nextIndex;
  const targetHash = markerHistory[markerHistoryIndex];
  history.replaceState(null, "", `${location.pathname}${location.search}${targetHash}`);
  updateMarkerButtons();
  restoringMarker = true;
  const target = document.getElementById(decodeURIComponent(targetHash.slice(1)));
  target?.scrollIntoView({ block: "start" });
  window.addEventListener("scrollend", () => { restoringMarker = false; }, { once: true });
  window.setTimeout(() => { restoringMarker = false; }, 500);
}

previousMarkerButton.addEventListener("click", () => moveInMarkerHistory(-1));
nextMarkerButton.addEventListener("click", () => moveInMarkerHistory(1));

const mobileQuery = window.matchMedia("(max-width: 48rem)");
const mobileBar = document.querySelector("#mobile-bar");
const articleJumpPanel = document.querySelector("#article-jump-panel");
const sheetButtons = [...document.querySelectorAll("#mobile-bar [data-sheet-target]")];
const articleJumpInput = document.querySelector("#article-jump-input");
const keyboardToggle = document.querySelector("#keyboard-toggle");
const searchHitNavs = [...document.querySelectorAll(".search-hit-nav")];

// Numeric keyboard only when explicitly requested; tapping the input itself gives the text keyboard.
keyboardToggle.addEventListener("click", () => {
  if (articleJumpInput.value.trim()) {
    articleJumpInput.form.requestSubmit();
    return;
  }
  articleJumpInput.blur();
  articleJumpInput.inputMode = "decimal";
  articleJumpInput.focus();
});

articleJumpInput.addEventListener("blur", () => {
  articleJumpInput.inputMode = "text";
});

document.addEventListener("input", event => {
  if (event.target !== articleJumpInput) return;
  const value = articleJumpInput.value.trim();
  keyboardToggle.textContent = !value ? "番号" : parseArticleNumber(value) ? "移動" : "検索";
  if (!value) clearArticleSearch();
});

function setSheet(name = "") {
  if (name) document.body.dataset.sheet = name;
  else delete document.body.dataset.sheet;
  sheetButtons.forEach(button => {
    button.setAttribute("aria-expanded", String(button.dataset.sheetTarget === name));
  });
}

function placeArticleJumpPanel() {
  if (mobileQuery.matches) {
    mobileBar.prepend(articleJumpPanel);
  } else {
    document.querySelector("#left-rail").prepend(articleJumpPanel);
    setSheet();
  }
}

function scrollRightPanelTo(target, behavior = "smooth") {
  const scrollArea = document.querySelector("#right-scroll");
  if (!target || !scrollArea) return false;
  scrollArea.scrollTo({
    top: scrollArea.scrollTop + target.getBoundingClientRect().top - scrollArea.getBoundingClientRect().top,
    behavior
  });
  return true;
}

function scrollActiveTocIntoView() {
  const panel = document.querySelector("#toc-panel");
  centerInScrollArea(panel, panel.querySelector('.toc-link[aria-current="location"]'));
}

document.querySelector("#mobile-bar-nav").addEventListener("click", event => {
  const button = event.target.closest("button[data-sheet-target]");
  if (!button) return;
  const name = button.dataset.sheetTarget;
  if (document.body.dataset.sheet === name) {
    setSheet();
    return;
  }
  setSheet(name);
  if (name === "toc") {
    updateActiveTocItem(); // recompute underline now that the panel is visible
    scrollActiveTocIntoView();
  } else {
    const scrollArea = document.querySelector("#right-scroll");
    scrollArea.scrollTop = 0;
    if (name === "amendment") centerInScrollArea(scrollArea, document.querySelector("#amendment-list .current-amendment"));
  }
});

document.addEventListener("click", event => {
  if (!document.body.dataset.sheet) return;
  if (event.target.closest("#mobile-bar, #toc-panel, #right-rail")) return;
  setSheet();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.body.dataset.sheet) setSheet();
});

new ResizeObserver(() => {
  document.documentElement.style.setProperty("--mobile-bar-height", `${mobileBar.offsetHeight}px`);
}).observe(mobileBar);

mobileQuery.addEventListener("change", placeArticleJumpPanel);
placeArticleJumpPanel();

document.querySelector("#toc").addEventListener("click", event => {
  const link = event.target.closest("a.toc-link");
  if (!link) return;
  const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
  if (!target) return;
  event.preventDefault();
  navigateToMarker(link.hash, target);
  if (mobileQuery.matches) setSheet();
});

content.addEventListener("click", event => {
  const heading = event.target.closest("h2, h3, h4, h5, h6");
  const articleHeading = event.target.closest(".article-heading");
  const target = heading?.parentElement || (articleHeading ? articleHeading.closest(".law-article") : null);
  if (!target || !content.contains(target) || !target.id) return;
  navigateToMarker(`#${target.id}`, target, "smooth");
});
let currentLawNumber = "";

function readViewHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(VIEW_HISTORY_KEY) || "[]");
    return Array.isArray(history) ? history.filter(entry => entry && typeof entry.id === "string") : [];
  } catch {
    return [];
  }
}

function readPinnedLaws() {
  try {
    const pinned = JSON.parse(localStorage.getItem(PINNED_LAWS_KEY) || "[]");
    return Array.isArray(pinned) ? pinned.filter(entry => entry && typeof entry.id === "string") : [];
  } catch {
    return [];
  }
}

function writePinnedLaws(pinned) {
  try {
    localStorage.setItem(PINNED_LAWS_KEY, JSON.stringify(pinned));
  } catch { /* Keep the current page usable when storage is unavailable. */ }
}

function makeLawLink(entry) {
  const link = document.createElement("a");
  link.href = `?${new URLSearchParams({ id: entry.id })}`;
  link.textContent = entry.title || entry.id;
  return link;
}

function makeDeleteButton(entry, onDelete, label, buttonText = "削除") {
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = buttonText;
  remove.setAttribute("aria-label", `${entry.title || entry.id}を${label}から${buttonText}`);
  remove.addEventListener("click", onDelete);
  return remove;
}
function makeMoveButton(entry, label, direction, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", `${entry.title || entry.id}を固定一覧内で${direction}へ移動`);
  button.addEventListener("click", onClick);
  return button;
}

function makeLawListActions(...buttons) {
  const actions = document.createElement("span");
  actions.className = "law-list-actions";
  actions.append(...buttons);
  return actions;
}

function renderViewHistory() {
  const list = document.querySelector("#view-history-list");
  if (!list) return;
  const pinnedList = document.querySelector("#pinned-laws-list");
  const pinnedSection = document.querySelector("#pinned-laws");
  const pinned = readPinnedLaws();
  const pinnedIds = new Set(pinned.map(entry => entry.id));
  pinnedList.replaceChildren();
  for (let index = 0; index < pinned.length; index++) {
    const entry = pinned[index];
    const item = document.createElement("li");
    const content = document.createElement("div");
    content.className = "law-item-content";

    const buttons = [];
    if (index > 0) {
      buttons.push(makeMoveButton(entry, "▲", "上", () => {
        if (index <= 0) return;
        const nextPinned = [...readPinnedLaws()];
        [nextPinned[index - 1], nextPinned[index]] = [nextPinned[index], nextPinned[index - 1]];
        writePinnedLaws(nextPinned);
        renderViewHistory();
      }));
    }

    buttons.push(makeDeleteButton(entry, () => {
      writePinnedLaws(readPinnedLaws().filter(item => item.id !== entry.id));
      renderViewHistory();
    }, "固定一覧", "解除"));
    content.append(
      makeLawLink(entry),
      makeLawListActions(...buttons),
    )
    item.append(content);
    pinnedList.append(item);
  }
  pinnedSection.hidden = pinned.length === 0;
  list.replaceChildren();
  for (const entry of readViewHistory().filter(entry => !pinnedIds.has(entry.id)).slice(0, MAX_VIEW_HISTORY)) {
    const item = document.createElement("li");
    const content = document.createElement("div");
    content.className = "law-item-content";
    const remove = makeDeleteButton(entry, () => {
      try {
        localStorage.setItem(VIEW_HISTORY_KEY, JSON.stringify(readViewHistory().filter(item => item.id !== entry.id)));
      } catch { /* Keep the current page usable when storage is unavailable. */ }
      trimUnusedCache();
      renderViewHistory();
    }, "閲覧履歴");
    const pin = document.createElement("button");
    pin.type = "button";
    pin.textContent = "固定";
    pin.setAttribute("aria-label", `${entry.title || entry.id}を固定`);
    pin.addEventListener("click", () => {
      const nextPinned = readPinnedLaws().filter(item => item.id !== entry.id);
      nextPinned.push(entry);
      writePinnedLaws(nextPinned);
      renderViewHistory();
    });
    content.append(makeLawLink(entry), makeLawListActions(pin, remove));
    item.append(content);
    list.append(item);
  }
  document.querySelector("#view-history").hidden = list.childElementCount === 0 && pinned.length === 0;
}

function rememberLaw(id, title) {
  const history = readViewHistory().filter(entry => entry.id !== id);
  history.unshift({ id, title });
  const trimmedHistory = history.slice(0, MAX_VIEW_HISTORY);
  try {
    localStorage.setItem(VIEW_HISTORY_KEY, JSON.stringify(trimmedHistory));
  } catch { /* Browsing still works when storage is unavailable. */ }
  if (history.length > MAX_VIEW_HISTORY) {
    trimUnusedCache();
  }
}

function formatRevisionTitle(title, revisionInfo = {}) {
  const date = revisionInfo.amendment_enforcement_date || revisionInfo.amendment_scheduled_enforcement_date;
  return date ? `${title}（${date} 施行）` : title;
}

function textOf(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (!value || typeof value !== "object") return "";
  // Skip reading annotations (Rt); keep base characters inside Ruby.
  if (value.tag === "Rt") return "";
  if (value.tag) return (value.children || []).map(textOf).join("");
  return "";
}

const headingLevels = new Map([
  ["PartTitle", 2], ["ChapterTitle", 3], ["SectionTitle", 4],
  ["SubsectionTitle", 5], ["DivisionTitle", 6]
]);
const inlineTags = new Set(["ParagraphNum", "ItemTitle", "Subitem1Title", "Subitem2Title", "Subitem3Title", "Ruby", "Rt"]);
const structuralTags = new Set(["Part", "Chapter", "Section", "Subsection", "Division"]);

function structureId(path) {
  return path.join("-");
}

function structureSegment(tag, number) {
  const prefixes = { Part: "p", Chapter: "c", Section: "s", Subsection: "ss", Division: "d" };
  return `${prefixes[tag] || tag.toLowerCase()}${String(number).replace(/[^\w-]/g, "")}`;
}

function articleId(number) {
  return `a${String(number).replaceAll("_", "-")}`;
}

function articleNumberParts(value) {
  return String(value).split(/[:：\-–—−]/).map(endpoint => endpoint.split("_").map(Number));
}

function compareArticleDistance(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function nearestArticle(target, articles) {
  const targetParts = articleNumberParts(target)[0];
  const entries = articles.map(article => ({
    article,
    number: article.querySelector("[data-article-number]")?.dataset.articleNumber
  })).filter(entry => entry.number);
  if (!entries.length) return null;
  const exact = entries.find(entry => entry.number === String(target));
  if (exact) return exact.article;
  const containingRange = entries.find(({ number }) => {
    const endpoints = articleNumberParts(number);
    const [start, end] = endpoints;
    return endpoints.length > 1
      && compareArticleDistance(start, targetParts) <= 0
      && compareArticleDistance(targetParts, end) <= 0;
  });
  if (containingRange) return containingRange.article;

  const first = articleNumberParts(entries[0].number)[0];
  const lastEndpoints = articleNumberParts(entries.at(-1).number);
  const last = lastEndpoints.at(-1);
  if (compareArticleDistance(targetParts, first) < 0) return entries[0].article;
  if (compareArticleDistance(targetParts, last) > 0) return entries.at(-1).article;

  let best = null;
  let bestDistance = null;
  entries.forEach(({ article, number }) => {
    const [start, end] = articleNumberParts(number);
    const spansTarget = compareArticleDistance(start, targetParts) <= 0
      && compareArticleDistance(targetParts, end) <= 0;
    const distance = spansTarget
      ? [0]
      : [start, end].map(endpoint => [
        Math.abs((endpoint[0] || 0) - (targetParts[0] || 0)),
        Math.abs((endpoint[1] || 0) - (targetParts[1] || 0)),
        Math.abs((endpoint[2] || 0) - (targetParts[2] || 0))
      ]).sort(compareArticleDistance)[0];
    if (bestDistance === null || compareArticleDistance(distance, bestDistance) < 0) {
      best = article;
      bestDistance = distance;
    }
  });
  return best;
}

function kanjiArticleTitleToArabic(title) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const smallUnits = { 十: 10, 百: 100, 千: 1000 };
  const convert = value => {
    let total = 0;
    let section = 0;
    let digit = 0;
    for (const character of value) {
      if (character in digits) digit = digits[character];
      else if (character in smallUnits) {
        section += (digit || 1) * smallUnits[character];
        digit = 0;
      } else if (character === "万") {
        total += (section + digit) * 10000;
        section = 0;
        digit = 0;
      } else if (character === "億") {
        total += (section + digit) * 100000000;
        section = 0;
        digit = 0;
      }
    }
    return String(total + section + digit);
  };
  return title.replace(/[〇零一二三四五六七八九十百千万]+/g, convert);
}

function formatSupplementaryLawNumber(value) {
  const toArabic = number => /^[〇零一二三四五六七八九]+$/.test(number)
    ? [...number].map(character => ({ 〇: "0", 零: "0", 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" })[character]).join("")
    : kanjiArticleTitleToArabic(number);
  return String(value).replace(
    /^(明治|大正|昭和|平成|令和)([^年]+)年(?:(.+?月.+?日))?([^第]+)第([^号]+)号$/,
    (_, era, year, _date, kind, number) => `${era}${toArabic(year)}年${kind}第${toArabic(number)}号`
  );
}

const SEARCH_HIT_LIMIT = 3000;
const supportsSearchHighlights = typeof Highlight === "function" && "highlights" in CSS;
const articleSearch = { query: "", hits: [], index: -1, capped: false };
let articleSearchSegments = null;

function parseArticleNumber(rawValue) {
  const value = rawValue
    .replace(/[０-９]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
    .replace(/[－ー‐‑‒–—−.．,，]/g, "-");
  const match = value.match(/^第?\s*(\d+(?:(?:条の|の|-)\s*\d+)*)\s*(?:条.*)?$/);
  const number = match?.[1].replace(/条の|の|-/g, "_").replace(/\s/g, "");
  return number && /^\d+(?:_\d+)*$/.test(number) ? number : null;
}

// Length-preserving normalization so offsets map 1:1 back to the DOM text.
function normalizeSearchText(value) {
  return value
    .replace(/[\uFF01-\uFF5E]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")
    .replace(/[A-Z]/g, character => character.toLowerCase());
}

// Text nodes grouped per block, so matches can span inline spans (parentheticals, ruby) but not paragraphs.
function buildArticleSearchSegments() {
  const segments = [];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.data && !node.parentElement?.closest("rt")
      ? NodeFilter.FILTER_ACCEPT
      : NodeFilter.FILTER_REJECT
  });
  let current = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = node.parentElement.closest("p, h2, h3, h4, h5, h6, th, td, div, section");
    if (!current || current.block !== block) {
      current = { block, nodes: [], text: "" };
      segments.push(current);
    }
    current.nodes.push({ node, start: current.text.length });
    current.text += normalizeSearchText(node.data);
  }
  return segments;
}

function locateSearchOffset(segment, offset, isEnd) {
  for (let index = segment.nodes.length - 1; index >= 0; index -= 1) {
    const { node, start } = segment.nodes[index];
    if (isEnd ? start < offset : start <= offset) return { node, offset: offset - start };
  }
  return { node: segment.nodes[0].node, offset: 0 };
}

function findArticleSearchHits(query) {
  if (!articleSearchSegments?.length) articleSearchSegments = buildArticleSearchSegments();
  const needle = normalizeSearchText(query);
  const hits = [];
  for (const segment of articleSearchSegments) {
    let from = 0;
    while (true) {
      const at = segment.text.indexOf(needle, from);
      if (at < 0) break;
      const start = locateSearchOffset(segment, at, false);
      const end = locateSearchOffset(segment, at + needle.length, true);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      hits.push(range);
      if (hits.length >= SEARCH_HIT_LIMIT) return { hits, capped: true };
      from = at + needle.length;
    }
  }
  return { hits, capped: false };
}

function paintCurrentSearchHit() {
  if (!supportsSearchHighlights) return;
  const current = articleSearch.hits[articleSearch.index];
  const highlight = current ? new Highlight(current) : new Highlight();
  highlight.priority = 1;
  CSS.highlights.set("article-search-current", highlight);
}

function updateSearchHitNav() {
  const total = articleSearch.hits.length;
  const label = total
    ? `${articleSearch.index + 1} / ${total}${articleSearch.capped ? "+" : ""}件`
    : "見つかりません";
  searchHitNavs.forEach(nav => {
    nav.hidden = !articleSearch.query;
    nav.querySelector(".search-hit-count").textContent = label;
    nav.querySelectorAll("[data-search-step]").forEach(button => {
      button.disabled = total === 0;
    });
  });
}

function showCurrentSearchHit() {
  const range = articleSearch.hits[articleSearch.index];
  if (!range) return;
  if (mobileQuery.matches) setSheet();
  updateSearchHitNav(); // first, so the mobile bar has its final height before scrolling
  paintCurrentSearchHit();
  revealSearchHit(range);
}

function revealSearchHit(range) {
  const element = range.startContainer.parentElement;
  const scroller = element?.closest(".law-table-scroll, .law-columns-scroll");
  if (scroller) {
    const hitRect = range.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    if (hitRect.left < scrollerRect.left || hitRect.right > scrollerRect.right) {
      scroller.scrollLeft += hitRect.left - scrollerRect.left - (scrollerRect.width - hitRect.width) / 2;
    }
  }
  const rect = range.getBoundingClientRect();
  const bottomInset = mobileQuery.matches && !mobileBar.hidden ? mobileBar.offsetHeight : 0;
  const visibleHeight = window.innerHeight - bottomInset;
  window.scrollTo({ top: window.scrollY + rect.top - (visibleHeight - rect.height) / 2 });
}

function moveSearchHit(offset) {
  const total = articleSearch.hits.length;
  if (!total) return;
  articleSearch.index = (articleSearch.index + offset + total) % total;
  showCurrentSearchHit();
}

function clearArticleSearch() {
  Object.assign(articleSearch, { query: "", hits: [], index: -1, capped: false });
  if (supportsSearchHighlights) {
    CSS.highlights.delete("article-search-hit");
    CSS.highlights.delete("article-search-current");
  }
  updateSearchHitNav();
}

function startArticleSearch(query) {
  if (query === articleSearch.query && articleSearch.hits.length) {
    moveSearchHit(1);
    return;
  }
  const { hits, capped } = findArticleSearchHits(query);
  Object.assign(articleSearch, { query, hits, capped, index: -1 });
  if (supportsSearchHighlights) CSS.highlights.set("article-search-hit", new Highlight(...hits));
  if (!hits.length) {
    paintCurrentSearchHit();
    updateSearchHitNav();
    return;
  }
  // Start from the first hit at or below the current scroll position.
  const firstVisible = hits.findIndex(range => range.getBoundingClientRect().top >= 0);
  articleSearch.index = Math.max(0, firstVisible);
  showCurrentSearchHit();
}

document.querySelector("#article-jump").addEventListener("submit", event => {
  event.preventDefault();
  const rawValue = articleJumpInput.value.trim();
  if (mobileQuery.matches) articleJumpInput.blur();
  if (!rawValue) {
    clearArticleSearch();
    return;
  }
  const number = parseArticleNumber(rawValue);
  const mainArticles = [...content.querySelectorAll(".law-main-provision .law-article")];
  const articles = mainArticles.length ? mainArticles : [...content.querySelectorAll(".law-article")];
  const article = number ? nearestArticle(number, articles) : null;
  if (article) {
    articleJumpInput.value = "";
    articleJumpInput.dispatchEvent(new Event("input", { bubbles: true }));
    clearArticleSearch();
    navigateToMarker(`#${article.id}`, article);
  } else {
    startArticleSearch(rawValue);
  }
});

articleJumpInput.addEventListener("keydown", event => {
  if (event.key !== "Enter" || !event.shiftKey || event.isComposing) return;
  if (!articleSearch.query || articleSearch.query !== articleJumpInput.value.trim()) return;
  event.preventDefault();
  moveSearchHit(-1);
});

searchHitNavs.forEach(nav => nav.addEventListener("click", event => {
  const step = event.target.closest("[data-search-step]");
  if (step) {
    moveSearchHit(Number(step.dataset.searchStep));
    return;
  }
  if (event.target.closest("[data-search-close]")) {
    articleJumpInput.value = "";
    articleJumpInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
}));

document.addEventListener("keydown", event => {
  if (event.altKey) return;
  const modifier = event.ctrlKey || event.metaKey;
  const interactive = event.target.closest("input, textarea, select, button, a, [contenteditable='true']");
  const findKey = lawId && modifier && !event.shiftKey && event.key.toLowerCase() === "f"
    && document.activeElement !== articleJumpInput;
  if (findKey || (!modifier && event.key === "/" && !interactive)) {
    event.preventDefault();
    articleJumpInput.focus();
    articleJumpInput.select();
    return;
  }
  if (modifier || event.shiftKey || interactive) return;
  const searchStep = { j: 1, k: -1 }[event.key];
  if (searchStep && articleSearch.hits.length) {
    event.preventDefault();
    moveSearchHit(searchStep);
    return;
  }
  const offset = ["h", "ArrowLeft"].includes(event.key) ? -1
    : ["l", "ArrowRight"].includes(event.key) ? 1
      : 0;
  if (!offset) return;
  event.preventDefault();
  moveInMarkerHistory(offset);
});

function findTag(node, tag) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) { const found = findTag(child, tag); if (found) return found; }
    return null;
  }
  if (node.tag === tag) return node;
  return findTag(node.children, tag);
}

function findTags(node, tag, matches = []) {
  if (!node || typeof node !== "object") return matches;
  if (Array.isArray(node)) {
    node.forEach(child => findTags(child, tag, matches));
    return matches;
  }
  if (node.tag === tag) matches.push(node);
  if (node.tag !== "TOC") findTags(node.children, tag, matches);
  return matches;
}

function collectArticleNumbers(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(collectArticleNumbers);
  if (node.tag === "Article") return node.attr?.Num == null ? [] : [String(node.attr.Num)];
  if (node.tag === "TOC") return [];
  return collectArticleNumbers(node.children);
}

function formatArticleNumber(number) {
  const [base, ...suffix] = String(number).split("_");
  return `${base}条${suffix.map(part => `の${part}`).join("")}`;
}

function articleNumberBoundary(value, edge) {
  const [start, end] = String(value).split(":");
  return edge === "end" ? end || start : start;
}

function formatArticleNumberRange(numbers) {
  if (!numbers.length) return "";
  const first = articleNumberBoundary(numbers[0], "start");
  const last = articleNumberBoundary(numbers[numbers.length - 1], "end");
  if (first === last) return formatArticleNumber(first);
  const [firstBase, ...firstSuffix] = first.split("_");
  const [lastBase, ...lastSuffix] = last.split("_");
  if (firstBase === lastBase && firstSuffix.length === 1 && lastSuffix.length === 1) {
    return `${firstBase}条の${firstSuffix[0]}–${lastSuffix[0]}`;
  }
  if (!firstSuffix.length && !lastSuffix.length) return `${firstBase}–${lastBase}条`;
  return `${formatArticleNumber(first)}–${formatArticleNumber(last)}`;
}

function hasStructureBelowChapter(node) {
  const children = Array.isArray(node) ? node : node?.children || [];
  return children.some(child => child && typeof child === "object"
    && (["Section", "Subsection", "Division"].includes(child.tag)
      || hasStructureBelowChapter(child)));
}

function renderTocFromStructure(node, parent, path = [], depth = 0, chapterIsLowest = false) {
  const children = Array.isArray(node) ? node : node?.children || [];
  children.forEach(child => {
    if (!child || typeof child !== "object" || child.tag === "TOC") return;
    if (!structuralTags.has(child.tag)) {
      renderTocFromStructure(child, parent, path, depth, chapterIsLowest);
      return;
    }
    const tag = child.tag;
    const titleNode = (child.children || []).find(item => item?.tag === `${tag}Title`);
    if (!titleNode) {
      renderTocFromStructure(child, parent, path, depth, chapterIsLowest);
      return;
    }
    const childPath = [...path, structureSegment(tag, child.attr?.Num ?? "0")];
    const item = document.createElement("li");
    item.className = depth === 0 ? "toc-top-level" : depth === 1 ? "toc-sublevel" : "toc-detail";
    item.classList.add(`toc-${tag.toLowerCase()}`);
    if (tag === "Chapter" && chapterIsLowest) {
      item.classList.add("toc-chapter-leaf");
    }
    const link = document.createElement("a");
    link.className = "toc-link";
    link.href = `#${structureId(childPath)}`;
    const title = textOf(titleNode.children).trim();
    const titleParts = title.match(/^(第[〇零一二三四五六七八九十百千万億0-9０-９]+(?:編|章|節|款|目)(?:の[〇零一二三四五六七八九十百千万億0-9０-９]+)?(?:及び第[〇零一二三四五六七八九十百千万億0-9０-９]+(?:編|章|節|款|目)(?:の[〇零一二三四五六七八九十百千万億0-9０-９]+)?)*)[\s　]+(.+)$/);
    const number = document.createElement("span");
    number.className = "toc-number";
    if (titleParts) {
      number.textContent = titleParts[1];
    } else number.setAttribute("aria-hidden", "true");
    const heading = document.createElement("span");
    heading.className = "toc-heading";
    heading.textContent = titleParts ? titleParts[2] : title;
    link.append(number, heading);
    const articleNumbers = collectArticleNumbers(child);
    if (articleNumbers.length) {
      const rangeLabel = document.createElement("span");
      rangeLabel.className = "article-range";
      rangeLabel.textContent = ["Part", "Chapter"].includes(tag)
        ? formatArticleNumberRange(articleNumbers)
        : formatArticleNumber(articleNumberBoundary(articleNumbers[0], "start"));
      link.append(rangeLabel);
    }
    item.append(link);
    parent.append(item);
    renderTocFromStructure(child, parent, childPath, depth + 1, chapterIsLowest);
  });
}

function appendInline(node, parent, grayParentheticals = false) {
  if (node == null) return;
  if (Array.isArray(node)) { node.forEach(child => appendInline(child, parent, grayParentheticals)); return; }
  if (typeof node === "string" || typeof node === "number") {
    const value = String(node);
    if (!grayParentheticals) {
      parent.append(document.createTextNode(value));
      return;
    }
    const pairs = {
      "（": { close: "）", kind: "parenthetical" },
      "(": { close: ")", kind: "parenthetical" },
      "「": { close: "」", kind: "quotation" },
      "『": { close: "』", kind: "quotation" }
    };
    const stack = [];
    const matching = new Map();
    const characters = [...value];
    characters.forEach((character, index) => {
      if (pairs[character]) {
        stack.push({ index, close: pairs[character].close });
      } else if (stack.length && character === stack[stack.length - 1].close) {
        matching.set(stack.pop().index, index);
      }
    });
    let current = parent;
    const active = [];
    let plainText = "";
    const flush = () => {
      if (!plainText) return;
      current.append(document.createTextNode(plainText));
      plainText = "";
    };
    characters.forEach((character, index) => {
      if (matching.has(index)) {
        flush();
        const kind = pairs[character].kind;
        const wrapper = document.createElement(kind === "quotation" ? "strong" : "span");
        if (kind === "quotation") wrapper.className = "law-quotation";
        else wrapper.className = "law-parenthetical";
        current.append(wrapper);
        active.push({ close: matching.get(index), parent: current });
        current = wrapper;
        plainText = character;
      } else if (active.at(-1)?.close === index) {
        plainText += character;
        flush();
        current = active.pop().parent;
      } else {
        plainText += character;
      }
    });
    flush();
    return;
  }
  if (typeof node !== "object") return;
  if (node.tag === "Ruby" || node.tag === "Rt") {
    const element = document.createElement(node.tag === "Ruby" ? "ruby" : "rt");
    (node.children || []).forEach(child => appendInline(child, element, grayParentheticals));
    parent.append(element);
    return;
  }
  (node.children || []).forEach(child => appendInline(child, parent, grayParentheticals));
}

function appendSentenceLines(nodes, parent, depth, structurePath, onCreateLine) {
  let line = null;
  let sentenceText = null;
  let sentenceCount = 0;
  const flush = () => {
    if (!line) return;
    parent.append(line);
    line = null;
    sentenceText = null;
    sentenceCount = 0;
  };
  (nodes || []).forEach(node => {
    if (node?.tag !== "Sentence") {
      flush();
      appendNode(node, parent, depth, structurePath);
      return;
    }
    if (!line) {
      line = document.createElement("p");
      line.className = "law-sentence";
      onCreateLine?.(line);
      sentenceText = document.createElement("span");
      sentenceText.className = "sentence-text";
      line.append(sentenceText);
    }
    if (sentenceCount) {
      const gap = document.createElement("span");
      gap.className = "sentence-gap";
      sentenceText.append(gap);
    }
    appendInline(node, sentenceText, true);
    sentenceCount += 1;
  });
  flush();
}

function isListItem(tag) {
  return ["Item", "Subitem1", "Subitem2", "Subitem3", "Subitem4"].includes(tag);
}

function appendListAware(node, parent, state, depth, structurePath) {
  if (!isListItem(node?.tag)) {
    state.list = null;
    state.tag = null;
    appendNode(node, parent, depth, structurePath);
    return;
  }
  if (!state.list || state.tag !== node.tag) {
    state.list = document.createElement("div");
    state.list.className = "law-list";
    parent.append(state.list);
    state.tag = node.tag;
  }
  appendNode(node, state.list, depth, structurePath);
}

function appendChildren(nodes, parent, depth, structurePath) {
  const state = { list: null, tag: null };
  nodes.forEach(node => appendListAware(node, parent, state, depth + 1, structurePath));
}

function renderMetadata(data) {
  const law = data.law_info || {};
  const revision = data.revision_info || {};
  const statuses = {
    CurrentEnforced: "施行中",
    UnEnforced: "未施行",
    PreviousEnforced: "過去に施行",
    Repeal: "廃止"
  };
  const lawTypes = {
    Constitution: "憲法", Act: "法律", CabinetOrder: "政令", ImperialOrder: "勅令",
    MinisterialOrdinance: "府省令", Rule: "規則", Misc: "その他"
  };
  const eras = { Meiji: "明治", Taisho: "大正", Showa: "昭和", Heisei: "平成", Reiwa: "令和" };
  const amendmentTypes = { "1": "新規制定", "3": "被改正", "8": "廃止" };
  const repealStatuses = {
    Repeal: "廃止", Expire: "失効", LossOfEffectiveness: "効力喪失"
  };
  const lawTitle = revision.law_title || "";
  const titleWithKana = lawTitle && revision.law_title_kana
    ? `${lawTitle}（${revision.law_title_kana}）`
    : lawTitle || revision.law_title_kana;
  const formatUpdated = value => {
    if (!value) return value;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
    const part = type => parts.find(entry => entry.type === type)?.value || "";
    return `${part("year")}年${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}:${part("second")}`;
  };
  const fields = [
    ["法令種別", lawTypes[law.law_type] || law.law_type || revision.law_type],
    ["分野", revision.category],
    ["法令名", titleWithKana],
    ["法令番号", law.law_num],
    ["法令ID", law.law_id, law.law_id ? `https://laws.e-gov.go.jp/law/${encodeURIComponent(law.law_id)}` : null],
    ["公布日", law.promulgation_date
      ? `${law.promulgation_date}${law.law_num_era && law.law_num_year != null
        ? `（${eras[law.law_num_era] || law.law_num_era}${law.law_num_year}年）`
        : ""}`
      : null],
    ["改正情報", "", null, true],
    ["改正法令名", revision.amendment_law_title],
    ["改正法令番号", revision.amendment_law_num],
    ["改正履歴ID", revision.law_revision_id, law.law_id && revision.law_revision_id
      ? `https://laws.e-gov.go.jp/law/${encodeURIComponent(law.law_id)}/${encodeURIComponent(revision.law_revision_id.slice(law.law_id.length + 1))}`
      : null],
    ["改正種別", amendmentTypes[String(revision.amendment_type)] || revision.amendment_type],
    ["改正公布日", revision.amendment_promulgate_date],
    ["施行日", revision.amendment_enforcement_date],
    ["施行予定日", revision.amendment_scheduled_enforcement_date],
    ["施行期日の注記", revision.amendment_enforcement_comment],
    ["施行状況", statuses[revision.current_revision_status] || revision.current_revision_status],
    ...(revision.repeal_status && revision.repeal_status !== "None" ? [
      ["廃止状況", repealStatuses[revision.repeal_status] || revision.repeal_status],
      ["廃止後も効力を有する", revision.remain_in_force == null ? null : revision.remain_in_force ? "はい" : "いいえ"]
    ] : []),
    ["", "", null, true],
    ["データ更新日時", formatUpdated(revision.updated)]
  ];
  const list = document.querySelector("#metadata-list");
  fields.forEach(([label, value, href, section]) => {
    if (section) {
      const sectionRow = document.createElement("div");
      sectionRow.className = "metadata-section-row";
      list.append(sectionRow);
      return;
    }
    if (value == null || value === "") return;
    const row = document.createElement("div");
    row.className = "metadata-row";
    if (label === "施行状況" && value !== "施行中") row.classList.add("metadata-status-not-current");
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.setAttribute("aria-label", `${label}をe-Gov法令検索で開く`);
      link.append(document.createTextNode(String(value)));
      const marker = document.createElement("span");
      marker.className = "external-link-mark";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = " ↗";
      link.append(marker);
      description.append(link);
    } else {
      description.textContent = String(value);
    }
    row.append(term, description);
    list.append(row);
  });
  if (list.childElementCount) {
    document.querySelector("#metadata-panel").hidden = false;
    document.querySelector("#right-rail").hidden = false;
    document.querySelector("#layout").classList.add("has-metadata");
  }
}

document.querySelector("#right-nav").addEventListener("click", event => {
  const link = event.target.closest("a[href^='#']");
  if (!link) return;
  if (scrollRightPanelTo(document.querySelector(link.getAttribute("href")))) event.preventDefault();
});

async function loadAmendmentHistory(lawId, currentRevisionId, currentRevisionStatus) {
  const panel = document.querySelector("#amendment-panel");
  const list = document.querySelector("#amendment-list");
  document.querySelector("#right-rail").hidden = false;
  document.querySelector("#layout").classList.add("has-metadata");
  try {
    const response = await fetch(`${REVISION_API}${encodeURIComponent(lawId)}?response_format=json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const revisions = data.revisions || [];

    // Find the latest revision in effect by picking the latest enforcement date (excluding future dates)
    const latestInEffect = findLatestRevision(revisions);
    if (latestInEffect?.law_revision_id) {
      setIndexedLatestRevision(lawId, latestInEffect.law_revision_id);
    }

    // 表示中の revision の施行状況を、revision API の値と比較する
    const displayedRevision = revisions.find(r => r.law_revision_id === currentRevisionId);
    const apiStatus = displayedRevision?.current_revision_status;
    if (currentRevisionId && apiStatus && apiStatus !== currentRevisionStatus) {
      setTimeout(async () => {
        if (!confirm("施行状況の更新が見つかりました。再読み込みして最新の情報を表示しますか？")) return;
        await deleteCachedLawData(currentRevisionId);
        location.reload();
      }, 100);
    }

    revisions.forEach(revision => {
      const item = document.createElement("li");
      const isCurrent = revision.law_revision_id === currentRevisionId;
      const isEnforced = revision.current_revision_status === "CurrentEnforced";
      if (isCurrent) {
        item.classList.add("current-amendment");
        item.setAttribute("aria-current", "true");
      }
      if (isEnforced) item.classList.add("enforced-amendment");
      const date = revision.amendment_enforcement_date || revision.amendment_scheduled_enforcement_date || revision.amendment_promulgate_date;
      if (date) {
        const time = document.createElement("time");
        time.dateTime = date;
        time.textContent = date;
        item.append(time);
      }
      if (isCurrent || isEnforced) {
        const current = document.createElement("span");
        current.className = "revision-status";
        current.textContent = `${date ? "・" : ""}${isEnforced ? "施行中" : "表示中"}`;
        item.append(current);
      }
      const title = document.createElement(isCurrent ? "span" : "a");
      title.className = "amendment-title";
      title.textContent = revision.amendment_law_title || "改正法令名なし";
      if (!isCurrent) title.href = `?${new URLSearchParams({ id: revision.law_revision_id })}`;
      item.append(title);
      list.append(item);
    });
    if (!list.childElementCount) {
      const empty = document.createElement("li");
      empty.textContent = "改正履歴はありません。";
      list.append(empty);
    }
  } catch {
    const error = document.createElement("li");
    error.textContent = "改正履歴を取得できませんでした。";
    list.append(error);
  }
}

function hasVisibleContent(element) {
  if (element.firstElementChild) return true;
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.data.trim()) return true;
  }
  return false;
}

function appendNode(node, parent, depth = 0, structurePath = []) {
  if (depth > 60 || node == null) return;
  if (Array.isArray(node)) { node.forEach(item => appendNode(item, parent, depth + 1, structurePath)); return; }
  if (typeof node === "string" || typeof node === "number") {
    parent.append(document.createTextNode(String(node)));
    return;
  }
  if (typeof node !== "object") return;

  const tag = node.tag || "";
  const children = node.children || [];
  if (tag === "TOC") return;
  const titleNode = structuralTags.has(tag) && children.find(child => child?.tag === `${tag}Title`);
  const nodePath = titleNode
    ? [...structurePath, structureSegment(tag, node.attr?.Num ?? "0")]
    : structurePath;
  if (tag === "Paragraph") {
    const paragraph = document.createElement("div");
    paragraph.className = "law-paragraph";
    if (node.attr?.Num) paragraph.dataset.paragraphNumber = node.attr.Num;
    const paragraphNum = children.find(child => child?.tag === "ParagraphNum");
    const hasNumber = paragraphNum && textOf(paragraphNum.children).trim();
    if (!hasNumber) paragraph.classList.add("law-paragraph-unmarked");
    let numberAdded = false;
    const listState = { list: null, tag: null };
    children.forEach(child => {
      if (!child || child.tag === "ParagraphNum") { listState.list = null; listState.tag = null; return; }
      if (child.tag === "ParagraphSentence") {
        listState.list = null;
        listState.tag = null;
        appendSentenceLines(child.children, paragraph, depth + 1, nodePath, line => {
          if (numberAdded) return;
          if (hasNumber) {
            const number = document.createElement("span");
            number.className = "paragraph-number";
            number.textContent = node.attr?.Num || textOf(paragraphNum.children).trim();
            line.append(number);
          } else {
            const indent = document.createElement("span");
            indent.className = "paragraph-indent";
            line.append(indent);
          }
          numberAdded = true;
        });
      } else appendListAware(child, paragraph, listState, depth + 1, nodePath);
    });
    if (paragraph.childNodes.length) parent.append(paragraph);
    return;
  }
  if (isListItem(tag)) {
    const item = document.createElement("div");
    item.className = `law-item ${tag.toLowerCase()}`;
    const title = children.find(child => child?.tag === `${tag}Title`);
    if (title) {
      const label = document.createElement("span");
      label.className = "item-number";
      label.textContent = textOf(title.children).trim();
      item.append(label);
    }
    const listState = { list: null, tag: null };
    children.filter(child => child !== title).forEach(child => {
      if (child?.tag === `${tag}Sentence`) {
        listState.list = null;
        listState.tag = null;
        const columns = (child.children || []).filter(sentence => sentence?.tag === "Column");
        if (columns.length) {
          const columnGroup = document.createElement("div");
          columnGroup.className = "law-item-columns";
          columns.forEach((column, index) => {
            const columnContent = document.createElement("div");
            columnContent.className = "law-item-column";
            appendSentenceLines(column.children, columnContent, depth + 1, nodePath);
            if (index === 0) {
              const itemNumber = item.querySelector(":scope > .item-number");
              if (itemNumber) {
                const numberedColumn = document.createElement("div");
                numberedColumn.className = "law-item-column-numbered";
                const columnBody = document.createElement("div");
                columnBody.className = "law-item-column-numbered-content";
                columnBody.append(...columnContent.childNodes);
                numberedColumn.append(itemNumber, columnBody);
                columnContent.append(numberedColumn);
              }
            }
            columnGroup.append(columnContent);
          });
          item.append(columnGroup);
        } else {
          appendSentenceLines(child.children, item, depth + 1, nodePath);
        }
      } else appendListAware(child, item, listState, depth + 1, nodePath);
    });
    if (item.childNodes.length) parent.append(item);
    return;
  }
  const level = headingLevels.get(tag) || null;
  const tableElements = {
    Table: "table", TableHeaderRow: "tr", TableHeaderColumn: "th",
    TableRow: "tr", TableColumn: "td"
  };
  const element = level
    ? document.createElement(`h${Math.min(level, 6)}`)
    : inlineTags.has(tag)
      ? document.createElement("span")
      : tableElements[tag]
        ? document.createElement(tableElements[tag])
        : ["Sentence", "Column", "FigureStruct"].includes(tag)
          ? document.createElement("p")
          : document.createElement("section");

  if (tag === "Table") {
    element.classList.add("law-table");
    const headerRows = children.filter(child => child?.tag === "TableHeaderRow");
    const rows = children.filter(child => child?.tag === "TableRow");
    if (headerRows.length) {
      const thead = document.createElement("thead");
      headerRows.forEach(row => appendNode(row, thead, depth + 1, nodePath));
      element.append(thead);
    }
    const tbody = document.createElement("tbody");
    rows.forEach(row => appendNode(row, tbody, depth + 1, nodePath));
    if (tbody.childNodes.length) element.append(tbody);
    const columnCount = Math.max(0, ...[...tbody.rows].map(row => row.cells.length));
    if (columnCount === 2) {
      element.classList.add("law-table-two-column");
      const colgroup = document.createElement("colgroup");
      for (let index = 0; index < 2; index += 1) {
        colgroup.append(document.createElement("col"));
      }
      element.insertBefore(colgroup, element.firstChild);
    }
    const isSubitemText = text => /^[ァ-ヶ][　\s]/u.test(text.trimStart());
    const isSubitemRow = row => isSubitemText(row.cells[0]?.textContent || "");
    const tableRows = [...tbody.rows];
    let group = [];
    const frameSubitemGroup = () => {
      if (!group.length) return;
      group.forEach((row, index) => {
        row.classList.add("law-table-subitem-row");
        const firstCell = row.cells[0];
        firstCell.classList.add("law-table-subitem-cell");
        if (index === 0) firstCell.classList.add("law-table-subitem-first");
        if (index === group.length - 1) firstCell.classList.add("law-table-subitem-last");
      });
      group = [];
    };
    tableRows.forEach(row => {
      if (isSubitemRow(row)) group.push(row);
      else frameSubitemGroup();
    });
    frameSubitemGroup();
    for (const cell of element.querySelectorAll("td, th")) {
      if (cell.parentElement.classList.contains("law-table-subitem-row")) continue;
      let subitemParagraphs = [];
      const frameSubitemParagraphs = () => {
        if (!subitemParagraphs.length) return;
        const frame = document.createElement("div");
        frame.className = "law-table-subitem-list";
        cell.insertBefore(frame, subitemParagraphs[0]);
        subitemParagraphs.forEach(paragraph => frame.append(paragraph));
        subitemParagraphs = [];
      };
      [...cell.children].forEach(child => {
        if (child.matches("p.law-sentence") && isSubitemText(child.textContent)) subitemParagraphs.push(child);
        else frameSubitemParagraphs();
      });
      frameSubitemParagraphs();
    }
  } else if (["TableHeaderRow", "TableRow"].includes(tag)) {
    children.forEach(child => appendNode(child, element, depth + 1, nodePath));
  } else if (["TableHeaderColumn", "TableColumn"].includes(tag)) {
    const borderStyle = { solid: "solid", dotted: "dotted", double: "double", none: "none" };
    for (const [attribute, side] of [["BorderTop", "top"], ["BorderRight", "right"], ["BorderBottom", "bottom"], ["BorderLeft", "left"]]) {
      const style = borderStyle[node.attr?.[attribute] || "solid"];
      if (style !== "solid") element.classList.add(`law-table-border-${side}-${style}`);
    }
    if (node.attr?.rowspan) element.rowSpan = Number(node.attr.rowspan);
    if (node.attr?.colspan) element.colSpan = Number(node.attr.colspan);
    if (["left", "center", "right", "justify"].includes(node.attr?.Align)) element.classList.add(`law-table-align-${node.attr.Align}`);
    appendChildren(children, element, depth, nodePath);
  } else if (tag === "Sentence") {
    element.classList.add("law-sentence");
    appendInline(node, element, true);
  } else if (level) {
    // Structure headings: show base text only (no furigana).
    element.textContent = textOf(children);
  }

  if (titleNode) {
    element.id = structureId(nodePath);
    element.classList.add("law-structure");
    element.classList.add(`law-structure-${tag.toLowerCase()}`);
  }
  if (tag === "TableStruct") element.classList.add("law-table-frame");
  if (tag === "MainProvision") element.classList.add("law-main-provision");
  if (tag === "SupplProvision") {
    element.classList.add("law-supplementary-provision");
    const labelNode = children.find(child => child?.tag === "SupplProvisionLabel");
    const titleNode = children.find(child => child?.tag === "SupplProvisionTitle");
    const heading = document.createElement("div");
    heading.className = "law-supplementary-heading";
    const headingLabel = document.createElement("span");
    headingLabel.className = "law-supplementary-heading-label";
    headingLabel.textContent = labelNode
      ? textOf(labelNode.children).trim().replace(/[\s　]+/g, "")
      : "附則";
    if (titleNode) {
      const title = document.createElement("span");
      title.className = "law-supplementary-heading-title";
      title.textContent = textOf(titleNode.children);
      headingLabel.append(" ", title);
    }
    const lawNumber = node.attr?.AmendLawNum || currentLawNumber;
    heading.append(headingLabel);
    if (lawNumber) {
      const number = document.createElement("span");
      number.className = "law-supplementary-law-number";
      number.textContent = lawNumber;
      heading.append(number);
    }
    element.append(heading);
  }

  if (tag === "LawTitle") return;
  if (tag === "Article") {
    element.classList.add("law-article");
    const articleTitle = children.find(child => child?.tag === "ArticleTitle");
    if (node.attr?.Num) element.id = articleId(node.attr.Num);
    if (node.attr?.Num) {
      const articleHeading = document.createElement("p");
      articleHeading.className = "article-heading";
      const articleNumber = document.createElement("strong");
      articleNumber.dataset.articleNumber = node.attr.Num;
      const [base, ...suffix] = String(node.attr.Num).split("_");
      const caption = children.find(child => child?.tag === "ArticleCaption");
      articleNumber.textContent = node.attr.Num.includes(":") && articleTitle
        ? kanjiArticleTitleToArabic(textOf(articleTitle))
        : `第${base}条${suffix.map(number => `の${number}`).join("")}`;
      articleHeading.append(articleNumber);
      if (caption) {
        articleHeading.append(document.createTextNode(" "));
        const captionText = document.createElement("strong");
        captionText.className = "article-caption";
        appendInline(caption, captionText);
        articleHeading.append(captionText);
      }
      element.append(articleHeading);
    }
    appendChildren(children.filter(child => child !== articleTitle && child?.tag !== "ArticleCaption"), element, depth, nodePath);
    const articleChildren = [...element.children];
    const paragraphNodes = children.filter(child => child?.tag === "Paragraph");
    const hasLegacyParagraphNumbers = paragraphNodes.length > 1
      && paragraphNodes.some(paragraph => paragraph.attr?.OldNum === "true")
      && paragraphNodes.every(paragraph => paragraph.attr?.Num
        && !textOf((paragraph.children || []).find(child => child?.tag === "ParagraphNum")?.children).trim());
    if (hasLegacyParagraphNumbers) {
      articleChildren.filter(child => child.classList.contains("law-paragraph-unmarked")).forEach(paragraph => {
        const number = Number(paragraph.dataset.paragraphNumber);
        const line = paragraph.querySelector(".law-sentence");
        if (!line || !Number.isInteger(number) || number < 1) return;
        line.querySelector(".paragraph-indent")?.remove();
        const marker = document.createElement("span");
        marker.className = "paragraph-number";
        marker.textContent = number <= 20 ? String.fromCodePoint(0x2460 + number - 1) : `(${number})`;
        line.prepend(marker);
      });
    }
  } else if (!level && !["Table", "TableHeaderRow", "TableRow", "TableHeaderColumn", "TableColumn", "Sentence"].includes(tag)) {
    appendChildren(tag === "SupplProvision"
      ? children.filter(child => !["SupplProvisionLabel", "SupplProvisionTitle"].includes(child?.tag))
      : children, element, depth, nodePath);
  }

  if (hasVisibleContent(element)) {
    const previous = parent.lastElementChild;
    let previousContent = previous;
    while (previousContent && !previousContent.classList.contains("law-article") && previousContent.lastElementChild) {
      previousContent = previousContent.lastElementChild;
    }
    if ((tag === "Article" || titleNode) && previousContent?.classList.contains("law-article")) {
      const separator = document.createElement("hr");
      separator.className = "article-separator";
      parent.append(separator);
    }
    parent.append(element);
  }
}

let threshold = -1;
function updateActiveTocItem() {
  const links = [...document.querySelectorAll("#toc-list .toc-link")];
  
  if (threshold === -1) {
    const h3Sample = document.querySelector("h3");

    // Calculate dynamic threshold from sticky h3 metrics
    if (h3Sample) {
      const style = getComputedStyle(h3Sample);
      const topOffset = parseFloat(style.top) || 0; // should be 0.5rem
      const h3Height = h3Sample.getBoundingClientRect().height;
      const bottomMargin = topOffset; // should be 0.5rem to match #content section.law-article margin

      threshold = topOffset + h3Height + bottomMargin;

      // Update CSS scroll-margin-top variable dynamically
      content.style.setProperty("--scroll-margin-offset", `${threshold}px`);
    }
  }

  if (!links.length) return;

  let active = null;
  for (const link of links) {
    const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    if (target && target.getBoundingClientRect().top <= threshold + 2) active = link;
    else if (target) break;
  }

  links.forEach(link => {
    if (link === active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });

  if (active) {
    const number = active.querySelector(".toc-number");
    const heading = active.querySelector(".toc-heading");
    const linkRect = active.getBoundingClientRect();
    const numberRect = number?.getBoundingClientRect();
    active.style.setProperty(
      "--toc-active-line-left", 
      `${numberRect ? numberRect.left - linkRect.left : 0}px`
    );

    const supplementaryEntry = active.closest(".toc-supplementary-provision");
    let headingRight = null;
    if (supplementaryEntry && heading) {
      const range = document.createRange();
      range.selectNodeContents(heading);
      const textRects = [...range.getClientRects()];
      if (textRects.length) headingRight = Math.max(...textRects.map(rect => rect.right));
    }
    active.style.setProperty(
      "--toc-active-line-right", 
      `${headingRight === null ? 0 : linkRect.right - headingRight}px`
    );
  }
}

// Initial calculation on load
window.addEventListener("DOMContentLoaded", updateActiveTocItem);
window.addEventListener("scroll", updateActiveTocItem, { passive: true });
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    threshold = -1;
    updateActiveTocItem();
  }, 250);
});

function makeTablesScrollable(root) {
  // Type 1: real tables (<table class="law-table">)
  root.querySelectorAll("table.law-table").forEach(table => {
    if (table.parentElement.closest(".law-table, .law-table-scroll-inner")) return;
    const scroller = document.createElement("div");
    scroller.className = "law-table-scroll";
    const inner = document.createElement("div");
    inner.className = "law-table-scroll-inner";
    table.before(scroller);
    inner.append(table);
    scroller.append(inner);
  });

  // Type 2: column-style lists (.law-list > .law-item > .law-item-columns)
  // Wrap the whole list so every row scrolls together and the columns stay lined up.
  root.querySelectorAll(".law-list").forEach(list => {
    if (!list.querySelector(":scope > .law-item > .law-item-columns")) return;
    if (list.closest(".law-table, .law-columns-scroll-inner")) return;
    const inner = document.createElement("div");
    inner.className = "law-columns-scroll-inner";
    inner.append(...list.childNodes);
    list.append(inner);
    list.classList.add("law-columns-scroll");
  });
}

async function load() {
  const setPageMetadata = (title, description) => {
    document.title = title;
    document.querySelector('meta[name="description"]').content = description;
    document.querySelector('meta[property="og:title"]').content = title;
    document.querySelector('meta[property="og:description"]').content = description;
    const currentUrl = `${location.origin}${location.pathname}${location.search}`;
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.append(canonical);
    }
    canonical.href = currentUrl;
    let ogUrl = document.querySelector('meta[property="og:url"]');
    if (!ogUrl) {
      ogUrl = document.createElement("meta");
      ogUrl.setAttribute("property", "og:url");
      document.head.append(ogUrl);
    }
    ogUrl.content = currentUrl;
  };
  if (!lawId) {
    setPageMetadata("法令検索 | いつでも法令閲覧 パソコンとスマホで見やすい法律サイト", "法令名や法令番号から日本の法令を検索し、条文と改正履歴を確認できます。");
    document.querySelector("#title").textContent = "法令検索";
    status.hidden = true;
    document.querySelector("#search-page").hidden = false;
    renderViewHistory();
    return;
  }
  const homeLink = document.querySelector("#home-link");
  homeLink.href = location.pathname;
  homeLink.hidden = false;
  document.querySelector("#mobile-home-link").href = location.pathname;
  mobileBar.hidden = false;
  try {
    const data = await fetchLawData(lawId);
    if (data.error || !data.law_full_text) throw new Error(data.error?.message || "法令が見つかりませんでした。法令IDや法令番号を確認してください。");
    const title = data.revision_info?.law_title || data.law_full_text?.children?.[0]?.children?.[0] || "法令条文";
    currentLawNumber = data.law_info?.law_num || "";
    const plainTitle = typeof title === "string" ? title : textOf(title);
    const revisionId = data.revision_info?.law_revision_id || lawId;
    const historyTitle = formatRevisionTitle(plainTitle, data.revision_info);
    rememberLaw(revisionId, historyTitle);
    setPageMetadata(`${plainTitle} | いつでも法令閲覧 パソコンとスマホで見やすい法律サイト`, `${plainTitle}の条文、法令情報、改正履歴を掲載しています。出典：e-Gov法令検索。`);
    document.querySelector("#title").textContent = plainTitle;
    renderMetadata(data);
    if (data.law_info?.law_id) {
      loadAmendmentHistory(
        data.law_info.law_id,
        data.revision_info?.law_revision_id,
        data.revision_info?.current_revision_status
      );
    }
    const mainProvision = findTag(data.law_full_text, "MainProvision");
    const supplementaryProvisions = findTags(data.law_full_text, "SupplProvision");
    if (mainProvision || supplementaryProvisions.length) {
      const list = document.createElement("ul");
      list.id = "toc-list";
      if (mainProvision) {
        const chapterIsLowest = !hasStructureBelowChapter(mainProvision);
        renderTocFromStructure(mainProvision, list, [], 0, chapterIsLowest);
      }
      if (supplementaryProvisions.length) {
        const group = document.createElement("li");
        group.className = "toc-top-level toc-part toc-supplementary-heading";
        const link = document.createElement("a");
        link.className = "toc-link";
        link.href = "#sp1";
        const number = document.createElement("span");
        number.className = "toc-number";
        const heading = document.createElement("span");
        heading.className = "toc-heading";
        number.textContent = "附則";
        heading.setAttribute("aria-hidden", "true");
        link.append(number, heading);
        group.append(link);

        const entries = document.createElement("ul");
        entries.className = "toc-supplementary-entries";
        supplementaryProvisions.forEach((provision, index) => {
          const item = document.createElement("li");
          item.className = "toc-sublevel toc-supplementary-provision";
          const entryLink = document.createElement("a");
          entryLink.className = "toc-link";
          entryLink.href = `#sp${index + 1}`;
          const entryNumber = document.createElement("span");
          entryNumber.className = "toc-number";
          entryNumber.textContent = String(index + 1);
          const entryHeading = document.createElement("span");
          entryHeading.className = "toc-heading";
          entryHeading.textContent = formatSupplementaryLawNumber(
            provision.attr?.AmendLawNum || data.law_info?.law_num || ""
          );
          entryLink.append(entryNumber, entryHeading);
          item.append(entryLink);
          entries.append(item);
        });
        group.append(entries);
        list.append(group);
      }
      const numberWidth = Math.max(1, ...[...list.querySelectorAll(".toc-number")].map(number => Array.from(number.textContent).length));
      list.style.setProperty("--toc-number-width", `${numberWidth}em`);
      if (list.childElementCount) {
        document.querySelector("#toc").append(list);
        document.querySelector("#layout").classList.add("has-toc");
        document.querySelector("#left-rail").hidden = false;
      }
    }
    appendNode(data.law_full_text, content);
    makeTablesScrollable(content);
    content.querySelectorAll(".law-supplementary-provision").forEach((provision, index) => {
      provision.id = `sp${index + 1}`;
    });
    status.hidden = true;
    content.hidden = false;
    const target = decodeURIComponent(location.hash.slice(1));
    requestAnimationFrame(() => {
      updateActiveTocItem();
      if (target) document.getElementById(target)?.scrollIntoView();
    });
  } catch (error) {
    status.classList.add("error");
    status.textContent = `${error.message} 時間をおいて再読み込みしてください。`;
  }
}

document.querySelector("#law-search").addEventListener("submit", async event => {
  event.preventDefault();
  const query = document.querySelector("#search-query").value.trim();
  if (!query) return;
  if (/^[A-Za-z0-9]{15}/.test(query)) {
    location.href = `?${new URLSearchParams({ id: query.toUpperCase() })}`;
    return;
  }
  const url = new URL(location.href);
  url.search = new URLSearchParams({ search: query }).toString();
  url.hash = "";
  history.pushState(null, "", url);
  await runSearch(query);
});

async function runSearch(query) {
  const searchStatus = document.querySelector("#search-status");
  const results = document.querySelector("#search-results");
  const params = new URLSearchParams({ law_title: query, limit: "100", offset: "0", response_format: "json" });
  results.replaceChildren();
  searchStatus.textContent = "検索しています…";
  try {
    const response = await fetch(`${SEARCH_API}?${params}`);
    if (!response.ok) throw new Error(`検索に失敗しました（${response.status}）。`);
    const data = await response.json();
    const laws = data?.laws || [];
    if (!laws.length) {
      searchStatus.textContent = "該当する法令はありません。";
      return;
    }
    searchStatus.textContent = `${data.total_count ?? laws.length}件の法令が見つかりました。`;
    document.querySelector("#view-history").hidden = true;
    for (const law of laws) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      const id = law.law_id || law.revision_info?.law_revision_id;
      link.href = `?${new URLSearchParams({ id })}`;
      link.textContent = law.revision_info?.law_title || law.law_title || law.law_num || id;
      item.append(link);
      const number = law.law_num || law.law_info?.law_num;
      if (number) {
        const detail = document.createElement("span");
        detail.textContent = `（${number}）`;
        item.append(detail);
      }
      results.append(item);
    }
  } catch (error) {
    searchStatus.textContent = `${error.message} 時間をおいて再試行してください。`;
  }
}

const initialSearch = new URLSearchParams(location.search).get("search");
if (initialSearch) {
  document.querySelector("#search-query").value = initialSearch;
  runSearch(initialSearch);
}

window.addEventListener("popstate", () => {
  if (lawId) return;
  const query = new URLSearchParams(location.search).get("search") || "";
  document.querySelector("#search-query").value = query;
  if (query) runSearch(query);
  else {
    document.querySelector("#search-results").replaceChildren();
    document.querySelector("#search-status").textContent = "";
    document.querySelector("#view-history").hidden = false;
  }
});

load();
