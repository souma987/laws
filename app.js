const API = "https://laws.e-gov.go.jp/api/2/law_data/";
const REVISION_API = "https://laws.e-gov.go.jp/api/2/law_revisions/";
const params = new URLSearchParams(location.search);
const lawKey = params.get("law_id") || params.get("law_num") || params.get("law_revision_id") || params.get("id");
const status = document.querySelector("#status");
const content = document.querySelector("#content");

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

document.querySelector("#article-jump").addEventListener("submit", event => {
  event.preventDefault();
  const input = document.querySelector("#article-jump-input");
  const message = document.querySelector("#article-jump-status");
  const number = input.value.trim()
    .replace(/[０-９]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
    .replace(/^第/, "")
    .replace(/条の/g, "_")
    .replace(/条/g, "")
    .replace(/の/g, "_")
    .replace(/[‐‑‒–—−]/g, "_");
  if (!/^\d+(?:_\d+)*$/.test(number)) {
    message.textContent = "条文番号を入力してください。例：424条の2";
    return;
  }
  const id = articleId(number);
  const displayNumber = number.includes("_")
    ? `第${number.replace("_", "条の")}`
    : `第${number}条`;
  const article = document.getElementById(id);
  if (!article) {
    message.textContent = `${displayNumber}は見つかりませんでした。`;
    return;
  }
  history.replaceState(null, "", `${location.pathname}${location.search}#${id}`);
  article.scrollIntoView({ block: "start" });
  message.textContent = `${displayNumber}へ移動しました。`;
});

document.addEventListener("keydown", event => {
  if (event.key !== "/" || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest("input, textarea, select, button, [contenteditable='true']")) return;
  event.preventDefault();
  const input = document.querySelector("#article-jump-input");
  input.focus();
  input.select();
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

function kanjiNumber(value) {
  const digits = { "〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of value) {
    if (char in digits) number = digits[char];
    else if (char === "十" || char === "百" || char === "千") {
      const unit = { "十": 10, "百": 100, "千": 1000 }[char];
      section += (number || 1) * unit;
      number = 0;
    } else if (char === "万" || char === "億") {
      total += (section + number) * (char === "万" ? 10000 : 100000000);
      section = 0;
      number = 0;
    }
  }
  return String(total + section + number);
}

function formatArticleRange(value) {
  const matches = [...value.matchAll(/第([〇零一二三四五六七八九十百千万億]+)条(?:の([〇零一二三四五六七八九十百千万億]+))?/g)]
    .map(match => ({ number: kanjiNumber(match[1]), suffix: match[2] ? kanjiNumber(match[2]) : "" }));
  if (!matches.length) return value.replace(/[（）()]/g, "").trim();
  if (matches.length === 1) return `${matches[0].number}条${matches[0].suffix ? `の${matches[0].suffix}` : ""}`;
  const first = matches[0];
  const last = matches[matches.length - 1];
  if (first.number === last.number && first.suffix && last.suffix) {
    return `${first.number}条の${first.suffix}–${last.suffix}`;
  }
  return `${first.number}${first.suffix ? `の${first.suffix}` : ""}–${last.number}条${last.suffix ? `の${last.suffix}` : ""}`;
}

function collectArticleRanges(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(collectArticleRanges);
  if (node.tag === "ArticleRange") return [textOf(node.children)];
  return collectArticleRanges(node.children);
}

function renderTocNode(node, parent, path = [], depth = 0) {
  (node.children || []).forEach(child => {
    if (!child || typeof child !== "object") return;
    if (!child.tag?.startsWith("TOC") || child.tag === "TOCLabel") return;
    const tag = child.tag.slice(3);
    const titleNode = (child.children || []).find(item => item?.tag === `${tag}Title`);
    if (!titleNode) return;
    const childPath = [...path, structureSegment(tag, child.attr?.Num ?? "0")];
    const item = document.createElement("li");
    item.className = depth === 0 ? "toc-top-level" : depth === 1 ? "toc-sublevel" : "toc-detail";
    const link = document.createElement("a");
    link.className = "toc-link";
    link.href = `#${structureId(childPath)}`;
    const title = textOf(titleNode.children).trim();
    const titleParts = title.match(/^(第[〇零一二三四五六七八九十百千万億0-9０-９]+(?:編|章|節|款|目)(?:の[〇零一二三四五六七八九十百千万億0-9０-９]+)?)[\s　]+(.+)$/);
    const number = document.createElement("span");
    number.className = "toc-number";
    if (titleParts) {
      number.textContent = titleParts[1];
    } else number.setAttribute("aria-hidden", "true");
    const heading = document.createElement("span");
    heading.className = "toc-heading";
    heading.textContent = titleParts ? titleParts[2] : title;
    link.append(number, heading);
    const ranges = collectArticleRanges(child);
    if (ranges.length) {
      const rangeLabel = document.createElement("span");
      rangeLabel.className = "article-range";
      rangeLabel.textContent = formatArticleRange(ranges.join(" "));
      link.append(rangeLabel);
    }
    item.append(link);
    parent.append(item);
    renderTocNode(child, parent, childPath, depth + 1);
  });
}

function appendInline(node, parent) {
  if (node == null) return;
  if (Array.isArray(node)) { node.forEach(child => appendInline(child, parent)); return; }
  if (typeof node === "string" || typeof node === "number") {
    parent.append(document.createTextNode(String(node)));
    return;
  }
  if (typeof node !== "object") return;
  if (node.tag === "Ruby" || node.tag === "Rt") {
    const element = document.createElement(node.tag === "Ruby" ? "ruby" : "rt");
    (node.children || []).forEach(child => appendInline(child, element));
    parent.append(element);
    return;
  }
  (node.children || []).forEach(child => appendInline(child, parent));
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
  const fields = [
    ["法令ID", law.law_id, law.law_id ? `https://laws.e-gov.go.jp/law/${encodeURIComponent(law.law_id)}` : null],
    ["法令番号", law.law_num],
    ["公布日", law.promulgation_date],
    ["改正履歴ID", revision.law_revision_id, law.law_id && revision.law_revision_id
      ? `https://laws.e-gov.go.jp/law/${encodeURIComponent(law.law_id)}/${encodeURIComponent(revision.law_revision_id.slice(law.law_id.length + 1))}`
      : null],
    ["改正法令番号", revision.amendment_law_num],
    ["改正公布日", revision.amendment_promulgate_date],
    ["施行日", revision.amendment_enforcement_date],
    ["施行予定日", revision.amendment_scheduled_enforcement_date],
    ["施行状況", statuses[revision.current_revision_status] || revision.current_revision_status],
    ["データ更新日", revision.updated]
  ];
  const list = document.querySelector("#metadata-list");
  fields.forEach(([label, value, href]) => {
    if (value == null || value === "") return;
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
    list.append(term, description);
  });
  if (list.childElementCount) {
    document.querySelector("#metadata-panel").hidden = false;
    document.querySelector("#right-rail").hidden = false;
    document.querySelector("#layout").classList.add("has-metadata");
  }
}

async function loadAmendmentHistory(lawId, currentRevisionId) {
  const panel = document.querySelector("#amendment-panel");
  const list = document.querySelector("#amendment-list");
  panel.hidden = false;
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
      } else if (isEnforced) {
        item.classList.add("enforced-amendment");
      }
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
      const link = document.createElement("a");
      link.href = `?${new URLSearchParams({ law_revision_id: revision.law_revision_id })}`;
      link.className = "amendment-title";
      link.textContent = revision.amendment_law_title || "改正法令名なし";
      item.append(link);
      if (isCurrent) {
        requestAnimationFrame(() => {
          const panelTop = panel.getBoundingClientRect().top + panel.clientTop;
          panel.scrollTop += item.getBoundingClientRect().top - panelTop;
        });
      }
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
    const paragraphNum = children.find(child => child?.tag === "ParagraphNum");
    const hasNumber = paragraphNum && textOf(paragraphNum.children).trim();
    let numberAdded = false;
    const listState = { list: null, tag: null };
    children.forEach(child => {
      if (!child || child.tag === "ParagraphNum") { listState.list = null; listState.tag = null; return; }
      if (child.tag === "ParagraphSentence") {
        listState.list = null;
        listState.tag = null;
        (child.children || []).forEach(sentence => {
          if (sentence?.tag !== "Sentence") { appendNode(sentence, paragraph, depth + 1, nodePath); return; }
          const line = document.createElement("p");
          line.className = "law-sentence";
          if (!numberAdded && hasNumber) {
            line.classList.add("has-number");
            const number = document.createElement("span");
            number.className = "paragraph-number";
            number.textContent = node.attr?.Num || textOf(paragraphNum.children).trim();
            line.append(number);
          }
          appendInline(sentence, line);
          paragraph.append(line);
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
        (child.children || []).forEach(sentence => {
          if (sentence?.tag === "Sentence") {
            const line = document.createElement("p");
            line.className = "law-sentence";
            appendInline(sentence, line);
            item.append(line);
          } else appendNode(sentence, item, depth + 1, nodePath);
        });
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
      articleNumber.textContent = `第${base}条${suffix.map(number => `の${number}`).join("")}`;
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
  } else {
    appendChildren(children, element, depth, nodePath);
  }

  if (element.textContent.trim() || element.children.length) {
    if (tag === "Article" && parent.lastElementChild?.classList.contains("law-article")) {
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
  const majorHeight = Math.max(0, ...[...content.querySelectorAll("h2")].map(heading => heading.offsetHeight));
  const chapterHeight = Math.max(0, ...[...content.querySelectorAll("h3")].map(heading => heading.offsetHeight));
  if (majorHeight) content.style.setProperty("--sticky-major-height", `${majorHeight}px`);
  if (chapterHeight) content.style.setProperty("--sticky-chapter-height", `${chapterHeight}px`);
}

window.addEventListener("resize", updateStickyHeadingHeight);

async function load() {
  if (!lawKey) {
    status.textContent = "URLに法令IDを指定してください。例：?law_id=411AC0000000127";
    return;
  }
  try {
    const response = await fetch(API + encodeURIComponent(lawKey) + "?" + new URLSearchParams({ response_format: "json", law_full_text_format: "json", json_format: "full" }));
    if (!response.ok) throw new Error(`法令APIから本文を取得できませんでした（${response.status}）。`);
    const data = await response.json();
    if (data.error || !data.law_full_text) throw new Error(data.error?.message || "法令本文が見つかりませんでした。法令IDや法令番号を確認してください。");
    const title = data.revision_info?.law_title || data.law_full_text?.children?.[0]?.children?.[0] || "法令本文";
    document.title = `${title} | 法令本文`;
    document.querySelector("#title").textContent = typeof title === "string" ? title : textOf(title);
    document.querySelector("#law-number").textContent = data.law_info?.law_num || "";
    renderMetadata(data);
    if (data.law_info?.law_id) loadAmendmentHistory(data.law_info.law_id, data.revision_info?.law_revision_id);
    const toc = findTag(data.law_full_text, "TOC");
    if (toc) {
      const list = document.createElement("ul");
      list.id = "toc-list";
      renderTocNode(toc, list);
      const numberWidth = Math.max(1, ...[...list.querySelectorAll(".toc-number")].map(number => Array.from(number.textContent).length));
      list.style.setProperty("--toc-number-width", `${numberWidth}em`);
      document.querySelector("#toc").append(list);
      document.querySelector("#layout").classList.add("has-toc");
      document.querySelector("#left-rail").hidden = false;
    }
    appendNode(data.law_full_text, content);
    status.hidden = true;
    content.hidden = false;
    const target = decodeURIComponent(location.hash.slice(1));
    requestAnimationFrame(() => {
      updateStickyHeadingHeight();
      if (target) document.getElementById(target)?.scrollIntoView();
    });
  } catch (error) {
    status.classList.add("error");
    status.textContent = `${error.message} 時間をおいて再読み込みしてください。`;
  }
}

load();
