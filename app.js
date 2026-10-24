const API = "https://laws.e-gov.go.jp/api/2/law_data/";
const SEARCH_API = "https://laws.e-gov.go.jp/api/2/laws";
const REVISION_API = "https://laws.e-gov.go.jp/api/2/law_revisions/";
const params = new URLSearchParams(location.search);
const lawId = params.get("law_id");
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

document.querySelector("#toc").addEventListener("click", event => {
  const link = event.target.closest("a.toc-link");
  if (!link) return;
  const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
  if (!target) return;
  event.preventDefault();
  navigateToMarker(link.hash, target);
});

content.addEventListener("click", event => {
  const heading = event.target.closest("h2, h3, h4, h5, h6");
  const articleHeading = event.target.closest(".article-heading");
  const target = heading?.parentElement || (articleHeading ? articleHeading.closest(".law-article") : null);
  if (!target || !content.contains(target) || !target.id) return;
  target.scrollIntoView({ block: "start", behavior: "smooth" });
});
let currentLawNumber = "";

function textOf(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (!value || typeof value !== "object") return "";
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
    /^(明治|大正|昭和|平成|令和)([^年]+)年(?:(.+?月.+?日))?(法律|政令|勅令|府令|省令|規則|条例)第([^号]+)号$/,
    (_, era, year, _date, kind, number) => `${era}${toArabic(year)}年${kind}第${toArabic(number)}号`
  );
}

document.querySelector("#article-jump").addEventListener("submit", event => {
  event.preventDefault();
  const input = document.querySelector("#article-jump-input");
  const value = input.value.trim()
    .replace(/[０-９]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
    .replace(/[－ー‐‑‒–—−]/g, "-");
  const match = value.match(/^第?\s*(\d+(?:(?:条の|の|-)\s*\d+)*)\s*(?:条.*)?$/);
  const number = match?.[1].replace(/条の|の|-/g, "_").replace(/\s/g, "");
  if (!number || !/^\d+(?:_\d+)*$/.test(number)) return;
  const mainArticles = [...content.querySelectorAll(".law-main-provision .law-article")];
  const articles = mainArticles.length ? mainArticles : [...content.querySelectorAll(".law-article")];
  const article = nearestArticle(number, articles);
  if (!article) return;
  navigateToMarker(`#${article.id}`, article);
});

document.addEventListener("keydown", event => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const interactive = event.target.closest("input, textarea, select, button, a, [contenteditable='true']");
  if (event.key === "/" && !interactive) {
    event.preventDefault();
    const input = document.querySelector("#article-jump-input");
    input.focus();
    input.select();
    return;
  }
  if (event.shiftKey || interactive) return;
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

function renderTocFromStructure(node, parent, path = [], depth = 0) {
  const children = Array.isArray(node) ? node : node?.children || [];
  children.forEach(child => {
    if (!child || typeof child !== "object" || child.tag === "TOC") return;
    if (!structuralTags.has(child.tag)) {
      renderTocFromStructure(child, parent, path, depth);
      return;
    }
    const tag = child.tag;
    const titleNode = (child.children || []).find(item => item?.tag === `${tag}Title`);
    if (!titleNode) {
      renderTocFromStructure(child, parent, path, depth);
      return;
    }
    const childPath = [...path, structureSegment(tag, child.attr?.Num ?? "0")];
    const item = document.createElement("li");
    item.className = depth === 0 ? "toc-top-level" : depth === 1 ? "toc-sublevel" : "toc-detail";
    item.classList.add(`toc-${tag.toLowerCase()}`);
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
    renderTocFromStructure(child, parent, childPath, depth + 1);
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
    if (sentenceCount) sentenceText.append(document.createElement("br"));
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
      link.rel = "noopener noreferrer";
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
  const fitMetadataRows = () => {
    list.querySelectorAll(".metadata-row").forEach(row => {
      const term = row.querySelector("dt");
      const description = row.querySelector("dd");
      const available = row.clientWidth;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const termWidth = term.getBoundingClientRect().width;
      const probe = description.cloneNode(true);
      Object.assign(probe.style, {
        position: "fixed", left: "-10000px", top: "0", width: "max-content",
        minWidth: "0", maxWidth: "none", whiteSpace: "nowrap", flex: "none"
      });
      document.body.append(probe);
      const preferredDescriptionWidth = probe.getBoundingClientRect().width;
      probe.remove();
      row.classList.toggle("metadata-row-stacked", termWidth + gap + preferredDescriptionWidth > available);
    });
  };
  fitMetadataRows();
  if ("ResizeObserver" in window) new ResizeObserver(fitMetadataRows).observe(list);
  window.addEventListener("resize", fitMetadataRows);
  if (list.childElementCount) {
    document.querySelector("#metadata-panel").hidden = false;
    document.querySelector("#right-rail").hidden = false;
    document.querySelector("#layout").classList.add("has-metadata");
  }
}

function selectRightTab(tab, moveFocus = false) {
  const tabs = [...document.querySelectorAll('#right-tabs [role="tab"]')];
  const panels = [document.querySelector('#metadata-panel'), document.querySelector('#amendment-panel')];
  const selectedIndex = tabs.indexOf(tab);
  tabs.forEach((item, index) => {
    const selected = index === selectedIndex;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    panels[index].hidden = !selected;
  });
  if (tab.id === "amendment-tab") {
    requestAnimationFrame(scrollCurrentAmendmentIntoView);
  }
  if (moveFocus) tab.focus();
}

function scrollCurrentAmendmentIntoView() {
  const panel = document.querySelector("#amendment-panel");
  const item = panel.querySelector(".current-amendment");
  if (!item || panel.hidden) return;
  const panelTop = panel.getBoundingClientRect().top + panel.clientTop;
  panel.scrollTop += item.getBoundingClientRect().top - panelTop;
}

document.querySelector('#right-tabs').addEventListener('click', event => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) selectRightTab(tab);
});
document.querySelector('#right-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('#right-tabs [role="tab"]')];
  const current = tabs.indexOf(document.activeElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  selectRightTab(tabs[index], true);
});

async function loadAmendmentHistory(lawId, currentRevisionId) {
  const panel = document.querySelector("#amendment-panel");
  const list = document.querySelector("#amendment-list");
  document.querySelector("#right-rail").hidden = false;
  document.querySelector("#layout").classList.add("has-metadata");
  try {
    const response = await fetch(`${REVISION_API}${encodeURIComponent(lawId)}?response_format=json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    (data.revisions || []).forEach(revision => {
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
      if (!isCurrent) title.href = `?${new URLSearchParams({ law_id: revision.law_revision_id })}`;
      item.append(title);
      list.append(item);
    });
    if (!list.childElementCount) {
      const empty = document.createElement("li");
      empty.textContent = "改正履歴はありません。";
      list.append(empty);
    }
    requestAnimationFrame(scrollCurrentAmendmentIntoView);
  } catch {
    const error = document.createElement("li");
    error.textContent = "改正履歴を取得できませんでした。";
    list.append(error);
  }
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
          if (numberAdded || !hasNumber) return;
          line.classList.add("has-number");
          const number = document.createElement("span");
          number.className = "paragraph-number";
          number.textContent = node.attr?.Num || textOf(paragraphNum.children).trim();
          line.append(number);
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
          columnGroup.style.gridTemplateColumns = `repeat(${columns.length}, minmax(0, 1fr))`;
          columns.forEach(column => {
            const columnContent = document.createElement("div");
            columnContent.className = "law-item-column";
            appendSentenceLines(column.children, columnContent, depth + 1, nodePath);
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
  const element = level
    ? document.createElement(`h${Math.min(level, 6)}`)
    : inlineTags.has(tag)
      ? document.createElement("span")
      : ["Sentence", "Column", "FigureStruct"].includes(tag)
        ? document.createElement("p")
        : document.createElement("section");

  if (titleNode) {
    element.id = structureId(nodePath);
    element.classList.add("law-structure");
    element.classList.add(`law-structure-${tag.toLowerCase()}`);
  }
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
      appendInline(titleNode, title);
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
        line.classList.add("has-number");
        const marker = document.createElement("span");
        marker.className = "paragraph-number";
        marker.textContent = number <= 20 ? String.fromCodePoint(0x2460 + number - 1) : `(${number})`;
        line.prepend(marker);
      });
    }
  } else {
    appendChildren(tag === "SupplProvision"
      ? children.filter(child => !["SupplProvisionLabel", "SupplProvisionTitle"].includes(child?.tag))
      : children, element, depth, nodePath);
  }

  if (element.textContent.trim() || element.children.length) {
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

function updateStickyHeadingHeight() {
  content.style.removeProperty("--sticky-major-height");
  content.style.removeProperty("--sticky-chapter-height");
  const partHeadings = [...content.querySelectorAll(".law-structure-part")]
    .filter(part => part.querySelector(".law-structure-chapter"));
  partHeadings.forEach(part => {
    const partHeading = part.querySelector(":scope > h2");
    part.querySelectorAll(".law-structure-chapter > h3").forEach(chapterHeading => {
      if (chapterHeading.querySelector(".sticky-part-title")) return;
      const partTitle = document.createElement("span");
      partTitle.className = "sticky-part-title";
      partTitle.textContent = partHeading.textContent;
      chapterHeading.prepend(partTitle);
    });
  });
  const majorHeight = Math.max(0, ...[...content.querySelectorAll("h2")]
    .filter(heading => !heading.parentElement.matches(".law-structure-part:has(.law-structure-chapter)"))
    .map(heading => heading.offsetHeight));
  const chapterHeight = Math.max(0, ...[...content.querySelectorAll("h3")].map(heading => heading.offsetHeight));
  content.style.setProperty("--sticky-major-height", `${majorHeight}px`);
  content.style.setProperty("--sticky-chapter-height", `${chapterHeight}px`);
}

function updateStickyPartTitles() {
  content.querySelectorAll(".law-structure-chapter > h3:has(.sticky-part-title)").forEach(heading => {
    const part = heading.closest(".law-structure-part");
    const headingRect = heading.getBoundingClientRect();
    const partBottom = part?.getBoundingClientRect().bottom ?? 0;
    const stickyTop = Number.parseFloat(getComputedStyle(heading).top) || 0;
    const stuck = headingRect.top <= stickyTop + 1 && partBottom > stickyTop + heading.offsetHeight;
    heading.classList.toggle("is-sticky", stuck);
  });
}

function updateActiveTocItem() {
  const links = [...document.querySelectorAll("#toc-list .toc-link")];
  if (!links.length) return;
  const threshold = 24 + (Number.parseFloat(getComputedStyle(content).getPropertyValue("--sticky-major-height")) || 0)
    + (Number.parseFloat(getComputedStyle(content).getPropertyValue("--sticky-chapter-height")) || 0);
  let active = null;
  for (const link of links) {
    const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    if (target && target.getBoundingClientRect().top <= threshold) active = link;
    else if (target) break;
  }
  links.forEach(link => {
    if (link === active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
  if (!restoringMarker) setUrlMarker(active?.hash || "#title");
}

window.addEventListener("scroll", updateStickyPartTitles, { passive: true });
window.addEventListener("scroll", updateActiveTocItem, { passive: true });
window.addEventListener("resize", updateStickyHeadingHeight);
window.addEventListener("resize", updateActiveTocItem);

async function load() {
  if (!lawId) {
    document.title = "法令検索";
    document.querySelector("#title").textContent = "法令検索";
    status.hidden = true;
    document.querySelector("#search-page").hidden = false;
    return;
  }
  try {
    const response = await fetch(API + encodeURIComponent(lawId) + "?" + new URLSearchParams({ response_format: "json", law_full_text_format: "json", json_format: "full" }));
    if (!response.ok) throw new Error(`法令APIから本文を取得できませんでした（${response.status}）。`);
    const data = await response.json();
    if (data.error || !data.law_full_text) throw new Error(data.error?.message || "法令本文が見つかりませんでした。法令IDや法令番号を確認してください。");
    const title = data.revision_info?.law_title || data.law_full_text?.children?.[0]?.children?.[0] || "法令本文";
    currentLawNumber = data.law_info?.law_num || "";
    document.title = `${title} | 法令本文`;
    document.querySelector("#title").textContent = typeof title === "string" ? title : textOf(title);
    renderMetadata(data);
    if (data.law_info?.law_id) loadAmendmentHistory(data.law_info.law_id, data.revision_info?.law_revision_id);
    const mainProvision = findTag(data.law_full_text, "MainProvision");
    const supplementaryProvisions = findTags(data.law_full_text, "SupplProvision");
    if (mainProvision || supplementaryProvisions.length) {
      const list = document.createElement("ul");
      list.id = "toc-list";
      if (mainProvision) renderTocFromStructure(mainProvision, list);
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
    content.querySelectorAll(".law-supplementary-provision").forEach((provision, index) => {
      provision.id = `sp${index + 1}`;
    });
    status.hidden = true;
    content.hidden = false;
    const target = decodeURIComponent(location.hash.slice(1));
    requestAnimationFrame(() => {
      updateStickyHeadingHeight();
      updateStickyPartTitles();
      if (target) document.getElementById(target)?.scrollIntoView();
      updateActiveTocItem();
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
    for (const law of laws) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      const id = law.law_id || law.revision_info?.law_revision_id;
      link.href = `?${new URLSearchParams({ law_id: id })}`;
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
});

load();
